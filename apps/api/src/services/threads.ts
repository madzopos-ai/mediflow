/**
 * Conversation threads and messages.
 *
 * Both the inbound webhook and the outbox worker write to these two tables, so
 * the thread key rule lives here rather than in either caller:
 *
 *   - One thread per (clinic, channel, patient), keyed by `external_key`.
 *   - The unread counter is incremented by inbound messages only. An outbound
 *     message does not create work for staff, and incrementing it here would
 *     make the badge disagree with the inbox.
 */

import { createId, type MessageDirection } from '@mediflow/shared';

import type { TenantHandle } from '../db/tenant.js';
import { nullable, type Row } from '../db/mappers.js';

export const THREAD_KEY_SEPARATOR = ':';

/** Stable per-patient, per-channel thread key. */
export function threadKey(patientId: string, channel = 'whatsapp'): string {
  return `${channel}${THREAD_KEY_SEPARATOR}${patientId}`;
}

export function ensureThread(
  tenant: TenantHandle,
  clinicId: string,
  patientId: string,
  externalKey: string,
  preview: string,
  now: string,
  inbound: boolean,
): string {
  const existing = tenant.find<Row>('message_threads', 'external_key = ?', [externalKey]);
  if (existing) {
    const id = String(existing['id']);
    tenant.update('message_threads', id, {
      last_message_at: now,
      last_preview: preview.slice(0, 140),
      // Only an inbound message creates unread work for staff.
      unread_count: inbound
        ? Number(existing['unread_count'] ?? 0) + 1
        : Number(existing['unread_count'] ?? 0),
      updated_at: now,
    });
    return id;
  }

  const id = createId('thr');
  tenant.insert('message_threads', {
    id,
    clinic_id: clinicId,
    patient_id: patientId,
    channel: 'whatsapp',
    external_key: externalKey,
    last_message_at: now,
    last_preview: preview.slice(0, 140),
    unread_count: inbound ? 1 : 0,
    created_at: now,
    updated_at: now,
  });
  return id;
}

export interface NewMessage {
  threadId: string;
  patientId: string;
  channel?: string;
  direction: MessageDirection;
  status: string;
  body: string;
  template?: string | null;
  providerMessageId?: string | null;
  externalMessageId?: string | null;
  appointmentId?: string | null;
  sentBy?: string | null;
  replyToMessageId?: string | null;
  mediaUrl?: string | null;
  parsedIntent?: unknown;
  parsedPayload?: unknown;
  /** Set for outbound messages whose provider send already succeeded. */
  sentAt?: string | null;
  deliveredAt?: string | null;
  readAt?: string | null;
  error?: string | null;
  now: string;
}

export function createMessage(tenant: TenantHandle, clinicId: string, input: NewMessage): string {
  const id = createId('msg');
  tenant.insert('messages', {
    id,
    clinic_id: clinicId,
    thread_id: input.threadId,
    patient_id: input.patientId,
    channel: input.channel ?? 'whatsapp',
    direction: input.direction,
    status: input.status,
    body: input.body,
    template: nullable(input.template),
    provider_message_id: nullable(input.providerMessageId),
    external_message_id: nullable(input.externalMessageId),
    parsed_intent: input.parsedIntent == null ? null : JSON.stringify(input.parsedIntent),
    parsed_payload: input.parsedPayload == null ? null : JSON.stringify(input.parsedPayload),
    media_url: nullable(input.mediaUrl),
    error: nullable(input.error),
    sent_at: nullable(input.sentAt),
    delivered_at: nullable(input.deliveredAt),
    read_at: nullable(input.readAt),
    appointment_id: nullable(input.appointmentId),
    sent_by: nullable(input.sentBy),
    reply_to_message_id: nullable(input.replyToMessageId),
    created_at: input.now,
    updated_at: input.now,
  });
  return id;
}

/**
 * Record a staff-initiated reply in the thread.
 *
 * Used by the inbox "reply" endpoint, which sends through the outbox like every
 * other outbound message rather than calling a provider inline, so that retries
 * and consent rules apply uniformly.
 */
export function markThreadRead(tenant: TenantHandle, threadId: string, now: string): void {
  tenant.update('message_threads', threadId, { unread_count: 0, updated_at: now });
}
