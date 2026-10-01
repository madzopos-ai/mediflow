/**
 * Reliable WhatsApp outbox.
 *
 * Every patient-facing message goes through this queue rather than being sent
 * inline. The failure modes we have to survive:
 *
 *   - **At-least-once delivery.** A timeout after the provider accepted the
 *     message must not cause a resend the patient sees twice. `dedupeKey` is
 *     what makes a retry safe.
 *   - **Exactly-once enqueue.** A reminder worker that runs twice must not
 *     produce two messages, so the same logical message collapses by key.
 *   - **No silent drops.** An exhausted retry budget goes to `dead` and is
 *     surfaced for review rather than vanishing.
 *   - **Consent at send time.** Opt-out is checked here, not only at enqueue,
 *     because a patient may opt out while a message waits in the queue.
 *     Safety-critical messages are the documented exception.
 *
 * Pure logic lives here; storage and the provider call belong to the API layer,
 * which implements `OutboxStore` against a table.
 */

import type { Channel, Language, OutboxStatus, ReminderTemplate } from '../domain/enums.js';
import type { OutboxMessage } from '../domain/types.js';
import { createId } from '../core/ids.js';
import { isValidE164, normalizePhone, nowIso } from '../core/time.js';

export interface OutboxEnqueueInput {
  clinicId: string;
  patientId: string;
  appointmentId?: string | null;
  /** E.164 phone number. */
  to: string;
  body: string;
  language: Language;
  channel: Channel;
  template: ReminderTemplate | 'custom' | 'critical_alert' | 'alert';
  /**
   * Stable identity of the logical message, e.g. `reminder:appt_123:24h`.
   * Two enqueues with the same key collapse to one message, which is what makes
   * the worker safe to run repeatedly.
   */
  dedupeKey: string;
  /** Earliest send time. Drives lead times and quiet hours. */
  scheduledFor?: string;
  /** Safety-critical messages bypass quiet hours and marketing opt-out. */
  safetyCritical?: boolean;
  correlationId?: string | null;
}

export type EnqueueResult =
  | { status: 'enqueued'; message: OutboxMessage }
  | { status: 'duplicate'; message: OutboxMessage }
  | { status: 'rejected'; reason: OutboxRejection };

export type OutboxRejection =
  | 'invalid_body'
  | 'invalid_recipient'
  | 'invalid_dedupe_key'
  | 'opted_out'
  | 'channel_disabled';

/** Consent state the caller resolved from the patient record. */
export interface ConsentState {
  /** Patient has opted out of non-essential messages. */
  optedOut: boolean;
  /** Clinic has the channel switched on. */
  channelEnabled: boolean;
}

export interface RetryPolicy {
  maxAttempts: number;
  baseDelaySeconds: number;
  maxDelaySeconds: number;
  /** Multiplicative backoff factor. */
  factor: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 5,
  baseDelaySeconds: 60,
  maxDelaySeconds: 60 * 60 * 6,
  factor: 2,
};

/** Normalise to E.164, or null when the number cannot be dialled. */
export function toE164(to: string, defaultDialCode = ''): string | null {
  const normalised = normalizePhone(to, defaultDialCode);
  if (!normalised || !isValidE164(normalised)) return null;
  return normalised;
}

/** Safety-critical messages sort ahead of routine traffic. */
export const PRIORITY = {
  critical: 0,
  transactional: 50,
  care: 100,
  marketing: 200,
} as const;

function priorityFor(safetyCritical: boolean, template: string): number {
  if (safetyCritical || template === 'critical_alert' || template === 'alert') return PRIORITY.critical;
  if (template === 'appointment_confirm' || template === 'appointment_cancel' || template === 'appointment_reminder' || template === 'appointment_reschedule' || template === 'payment_reminder') {
    return PRIORITY.transactional;
  }
  if (template === 'birthday_wish') return PRIORITY.marketing;
  return PRIORITY.care;
}

/**
 * Delay before the next attempt.
 *
 * Deterministic (no jitter) so the behaviour is testable; a production
 * deployment should add jitter upstream to spread a retry storm.
 */
export function backoffDelaySeconds(attempt: number, policy: RetryPolicy = DEFAULT_RETRY_POLICY): number {
  if (attempt < 1) return 0;
  const raw = policy.baseDelaySeconds * policy.factor ** (attempt - 1);
  return Math.min(Math.round(raw), policy.maxDelaySeconds);
}

/** Payload fields the outbox carries that have no dedicated column. */
export interface OutboxPayloadExtras {
  language: Language;
  safetyCritical: boolean;
}

function buildMessage(input: OutboxEnqueueInput, policy: RetryPolicy, now: string): OutboxMessage {
  const safetyCritical = input.safetyCritical ?? false;
  return {
    id: createId('msg'),
    clinicId: input.clinicId,
    channel: input.channel,
    to: input.to,
    body: input.body,
    template: input.template,
    payload: {
      language: input.language,
      safetyCritical,
    } satisfies OutboxPayloadExtras,
    status: 'pending',
    scheduledFor: input.scheduledFor ?? now,
    attempts: 0,
    maxAttempts: policy.maxAttempts,
    lastAttemptAt: null,
    sentAt: null,
    lastError: null,
    providerMessageId: null,
    appointmentId: input.appointmentId ?? null,
    patientId: input.patientId,
    dedupeKey: input.dedupeKey,
    lockedBy: null,
    lockedAt: null,
    correlationId: input.correlationId ?? null,
    priority: priorityFor(safetyCritical, input.template),
    // Mirrored out of `payload` so the consent sweep can read it from a column
    // instead of parsing JSON on every row.
    safetyCritical,
    createdAt: now,
    updatedAt: now,
  };
}

export async function enqueueMessage(
  input: OutboxEnqueueInput,
  store: OutboxStore,
  consent: ConsentState,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
  now: string = nowIso(),
): Promise<EnqueueResult> {
  if (!input.dedupeKey || input.dedupeKey.trim() === '') {
    return { status: 'rejected', reason: 'invalid_dedupe_key' };
  }
  const to = toE164(input.to);
  if (!to) {
    return { status: 'rejected', reason: 'invalid_recipient' };
  }
  if (!input.body || input.body.trim() === '') {
    return { status: 'rejected', reason: 'invalid_body' };
  }
  // Enforced here and again at send time: the patient can opt out between the
  // two moments. Safety-critical messages are exempt by design.
  if (!consent.channelEnabled) {
    return { status: 'rejected', reason: 'channel_disabled' };
  }
  if (consent.optedOut && !input.safetyCritical) {
    return { status: 'rejected', reason: 'opted_out' };
  }

  const existing = await store.getByDedupeKey(input.clinicId, input.dedupeKey);
  if (existing) {
    return { status: 'duplicate', message: existing };
  }

  const message = { ...buildMessage({ ...input, to }, policy, now) };
  await store.insert(message);
  return { status: 'enqueued', message };
}

/** Minimal persistence contract the API layer implements. */
export interface OutboxStore {
  getByDedupeKey(clinicId: string, dedupeKey: string): Promise<OutboxMessage | null>;
  insert(message: OutboxMessage): Promise<void>;
  update(message: OutboxMessage): Promise<void>;
  listDue(clinicId: string, now: string, limit: number): Promise<OutboxMessage[]>;
}

export interface SendAttempt {
  message: OutboxMessage;
  /** Key to hand the provider so a retry cannot double-send. */
  providerIdempotencyKey: string;
}

/**
 * Claim a batch of due messages in the order they should go out.
 *
 * Priority first, then schedule time: a critical alert must not sit behind a
 * reminder backlog. `lockedBy`/`lockedAt` on the row are what stop two workers
 * from claiming the same message.
 */
export function orderForSending(messages: readonly OutboxMessage[]): OutboxMessage[] {
  return messages
    .slice()
    .sort((a, b) => a.priority - b.priority || a.scheduledFor.localeCompare(b.scheduledFor) || a.createdAt.localeCompare(b.createdAt));
}

export async function claimDueMessages(
  clinicId: string,
  store: OutboxStore,
  now: string,
  workerId: string,
  limit = 50,
): Promise<SendAttempt[]> {
  const due = orderForSending(await store.listDue(clinicId, now, limit));
  const attempts: SendAttempt[] = [];
  for (const message of due) {
    // Mark claimed before returning so a second worker cannot pick the same row
    // up while this one is awaiting the provider.
    const claimed: OutboxMessage = {
      ...message,
      status: 'processing',
      lockedBy: workerId,
      lockedAt: now,
      updatedAt: now,
    };
    await store.update(claimed);
    attempts.push({
      message: claimed,
      providerIdempotencyKey: `${message.clinicId}:${message.dedupeKey ?? message.id}`,
    });
  }
  return attempts;
}

export type SendOutcome =
  | { ok: true; providerMessageId: string; sentAt?: string }
  | { ok: false; error: string; retryable?: boolean };

export interface SendResult {
  message: OutboxMessage;
  nextStatus: OutboxStatus;
  /** True when a human must look at this message. */
  needsReview: boolean;
}

/**
 * Apply a send result.
 *
 * A non-retryable failure is terminal immediately, because retrying a rejected
 * number just burns the queue. A retryable failure returns the row to `pending`
 * with a backed-off `scheduledFor`; exhausting the budget marks it `dead` so it
 * surfaces instead of disappearing.
 */
export function applySendResult(
  message: OutboxMessage,
  outcome: SendOutcome,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
  now: string = nowIso(),
): SendResult {
  if (outcome.ok) {
    return {
      message: {
        ...message,
        status: 'sent',
        sentAt: outcome.sentAt ?? now,
        providerMessageId: outcome.providerMessageId,
        attempts: message.attempts + 1,
        lastAttemptAt: now,
        lastError: null,
        updatedAt: now,
      },
      nextStatus: 'sent',
      needsReview: false,
    };
  }

  const attempts = message.attempts + 1;
  const retryable = outcome.retryable !== false;

  if (!retryable || attempts >= policy.maxAttempts) {
    return {
      message: {
        ...message,
        status: 'dead',
        attempts,
        lastAttemptAt: now,
        lastError: outcome.error,
        updatedAt: now,
      },
      nextStatus: 'dead',
      needsReview: true,
    };
  }

  const delaySeconds = backoffDelaySeconds(attempts, policy);
  return {
    message: {
      ...message,
      status: 'pending',
      attempts,
      lastAttemptAt: now,
      lastError: outcome.error,
      scheduledFor: new Date(Date.parse(now) + delaySeconds * 1000).toISOString(),
      updatedAt: now,
    },
    nextStatus: 'pending',
    needsReview: false,
  };
}

/** Per-clinic delivery counters for the dashboard. */
export function summariseOutbox(messages: readonly OutboxMessage[]): Record<OutboxStatus, number> {
  const stats: Record<OutboxStatus, number> = { pending: 0, processing: 0, sent: 0, failed: 0, dead: 0 };
  for (const message of messages) {
    stats[message.status] += 1;
  }
  return stats;
}

/** Messages that need a human, for the admin queue. */
export function messagesNeedingReview(messages: readonly OutboxMessage[]): OutboxMessage[] {
  return messages
    .filter((m) => m.status === 'dead' || (m.status === 'failed' && m.lastError !== null))
    .sort((a, b) => b.attempts - a.attempts || a.scheduledFor.localeCompare(b.scheduledFor));
}
