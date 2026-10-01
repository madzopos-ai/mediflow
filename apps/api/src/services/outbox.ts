/**
 * Outbound message queue.
 *
 * Two properties matter here:
 *
 *   1. **Atomic claiming.** `listDue` followed by a separate `update` would let
 *      two workers send the same message. The claim is a single
 *      `UPDATE ... WHERE id IN (...)` guarded by `status = 'pending'`, and the
 *      number of rows it actually changed is the number of messages this worker
 *      owns. Anything not claimed belongs to someone else.
 *
 *   2. **Consent is re-checked at send time, not just at enqueue time.** A
 *      patient can opt out between the message being queued and it being sent.
 *      Claiming therefore drops any message whose patient has since opted out.
 */

import { createId, type OutboxMessage } from '@mediflow/shared';

import type { Db } from '../db/index.js';
import type { TenantHandle } from '../db/tenant.js';
import { bit, jsonColumn, toOutboxMessage, type Row } from '../db/mappers.js';

export interface QueueInput {
  to: string;
  body: string;
  template: OutboxMessage['template'];
  channel?: OutboxMessage['channel'];
  patientId?: string | null;
  appointmentId?: string | null;
  dedupeKey?: string | null;
  correlationId?: string | null;
  scheduledFor?: string;
  maxAttempts?: number;
  priority?: number;
  /**
   * Bypasses the marketing opt-out and quiet hours. Reserved for
   * patient-safety messages such as a critical reading alert.
   */
  safetyCritical?: boolean;
  now?: string;
}

/** Lower runs first. Safety-critical messages sort ahead of the backlog. */
export const PRIORITY = {
  critical: 0,
  clinical: 10,
  transactional: 50,
  routine: 100,
} as const;

export interface QueueResult {
  row: Row;
  message: OutboxMessage;
  /** False when an existing dedupe key suppressed the insert. */
  enqueued: boolean;
}

export function queueOutbound(tenant: TenantHandle, input: QueueInput): QueueResult {
  const now = input.now ?? new Date().toISOString();
  const channel = input.channel ?? 'whatsapp';
  const priority = input.priority ?? (input.safetyCritical ? PRIORITY.critical : PRIORITY.routine);

  // Idempotency: the unique index on (clinic_id, dedupe_key) is what actually
  // prevents a double send, so check-then-insert is only a fast path.
  if (input.dedupeKey) {
    const existing = tenant.find<Row>('outbox', 'dedupe_key = ?', [input.dedupeKey]);
    if (existing) {
      return { row: existing, message: toOutboxMessage(existing), enqueued: false };
    }
  }

  const id = createId('obx');
  tenant.insert('outbox', {
    id,
    clinic_id: tenant.clinicId,
    channel,
    to_phone: input.to,
    body: input.body,
    template: input.template,
    payload: jsonColumn({ safetyCritical: input.safetyCritical === true }),
    status: 'pending',
    scheduled_for: input.scheduledFor ?? now,
    attempts: 0,
    max_attempts: input.maxAttempts ?? 5,
    last_attempt_at: null,
    sent_at: null,
    last_error: null,
    provider_message_id: null,
    appointment_id: input.appointmentId ?? null,
    patient_id: input.patientId ?? null,
    dedupe_key: input.dedupeKey ?? null,
    locked_by: null,
    locked_at: null,
    correlation_id: input.correlationId ?? null,
    priority,
    safety_critical: bit(input.safetyCritical === true),
    created_at: now,
    updated_at: now,
  });

  const row = tenant.get<Row>('outbox', id);
  if (!row) throw new Error('Outbox insert did not persist.');
  return { row, message: toOutboxMessage(row), enqueued: true };
}

export interface ClaimOptions {
  workerId: string;
  limit?: number;
  now?: string;
}

/**
 * Atomically claim due messages for one worker.
 *
 * Returns only the messages this call actually claimed, so two workers running
 * the same tick never send the same row.
 */
export function claimDue(db: Db, clinicId: string, options: ClaimOptions): OutboxMessage[] {
  const now = options.now ?? new Date().toISOString();
  const limit = Math.min(options.limit ?? 25, 200);

  const claim = db.transaction((): Row[] => {
    const candidates = db
      .prepare(
        `SELECT * FROM outbox
          WHERE clinic_id = ?
            AND status = 'pending'
            AND scheduled_for <= ?
            AND attempts < max_attempts
          ORDER BY priority ASC, scheduled_for ASC
          LIMIT ?`,
      )
      .all(clinicId, now, limit) as Row[];

    if (candidates.length === 0) return [];

    const ids = candidates.map((r) => String(r['id']));
    // The status guard is what makes this safe: if another worker claimed a row
    // first, this statement will not match it and it is excluded below.
    const result = db
      .prepare(
        `UPDATE outbox
            SET status = 'processing', locked_by = ?, locked_at = ?, attempts = attempts + 1, updated_at = ?
          WHERE clinic_id = ? AND id IN (${ids.map(() => '?').join(',')}) AND status = 'pending'`,
      )
      .run(options.workerId, now, now, clinicId, ...ids);

    if (result.changes === 0) return [];

    return db
      .prepare(
        `SELECT * FROM outbox
          WHERE clinic_id = ? AND id IN (${ids.map(() => '?').join(',')}) AND locked_by = ?`,
      )
      .all(clinicId, ...ids, options.workerId) as Row[];
  });

  return claim().map(toOutboxMessage);
}

/**
 * Messages claimed by a worker that never reported back, reset so a crash
 * does not strand them in 'processing' forever.
 */
export function requeueStale(db: Db, clinicId: string, staleAfterMinutes = 10, now = new Date().toISOString()): number {
  const cutoff = new Date(Date.parse(now) - staleAfterMinutes * 60_000).toISOString();
  const result = db
    .prepare(
      `UPDATE outbox
          SET status = 'pending', locked_by = NULL, locked_at = NULL, updated_at = ?
        WHERE clinic_id = ? AND status = 'processing' AND locked_at < ?`,
    )
    .run(now, clinicId, cutoff);
  return result.changes;
}

export function markSent(tenant: TenantHandle, id: string, providerMessageId: string | null, now = new Date().toISOString()): void {
  tenant.update('outbox', id, {
    status: 'sent',
    sent_at: now,
    provider_message_id: providerMessageId,
    last_error: null,
    locked_by: null,
    locked_at: null,
    updated_at: now,
  });
}

/**
 * Record a send failure with exponential backoff.
 *
 * Exhausting the attempts moves the message to 'dead' rather than dropping it,
 * so it appears in the review queue instead of vanishing.
 */
export function markFailed(tenant: TenantHandle, id: string, error: string, now = new Date().toISOString()): OutboxMessage {
  const row = tenant.require<Row>('outbox', id);
  const attempts = Number(row['attempts'] ?? 0);
  const maxAttempts = Number(row['max_attempts'] ?? 5);
  const dead = attempts >= maxAttempts;

  // 1m, 2m, 4m, 8m, 16m - capped so a long outage does not push a reminder
  // hours past the appointment it was for.
  const backoffMinutes = Math.min(2 ** Math.max(0, attempts - 1), 30);

  tenant.update('outbox', id, {
    status: dead ? 'dead' : 'pending',
    last_error: error.slice(0, 500),
    scheduled_for: dead ? String(row['scheduled_for']) : new Date(Date.parse(now) + backoffMinutes * 60_000).toISOString(),
    locked_by: null,
    locked_at: null,
    updated_at: now,
  });
  return toOutboxMessage(tenant.require<Row>('outbox', id));
}

/**
 * Consent re-check at send time.
 *
 * Returns the messages that must be dropped because the patient has opted out
 * since they were queued. Critical alerts are exempt: withholding a critical
 * reading acknowledgement would be the more harmful failure.
 */
export function dropOptedOut(tenant: TenantHandle, messages: readonly OutboxMessage[], now = new Date().toISOString()): OutboxMessage[] {
  const dropped: OutboxMessage[] = [];
  for (const message of messages) {
    if (!message.patientId) continue;
    // Patient-safety messages are exempt from the opt-out: a patient may stop
    // receiving reminders and still must be told their critical reading came
    // through. Decided by the flag written at enqueue time rather than by
    // matching template names, which missed alerts sent through any other
    // template and silently dropped them.
    if (message.safetyCritical) continue;

    const patient = tenant.get<{ whatsapp_opt_in: number; marketing_opt_in: number }>('patients', message.patientId);
    if (!patient) {
      // The patient was deleted; there is no one to send to.
      tenant.update('outbox', message.id, {
        status: 'dead',
        last_error: 'Patient no longer exists.',
        locked_by: null,
        locked_at: null,
        updated_at: now,
      });
      dropped.push(message);
      continue;
    }
    if (!Number(patient.whatsapp_opt_in)) {
      tenant.update('outbox', message.id, {
        status: 'dead',
        last_error: 'Patient opted out before this message was sent.',
        locked_by: null,
        locked_at: null,
        updated_at: now,
      });
      dropped.push(message);
    }
  }
  return dropped;
}
