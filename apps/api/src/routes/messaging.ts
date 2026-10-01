/**
 * Messaging endpoints: threads, messages, manual send, and the inbound webhook.
 *
 * The inbound webhook is the only way an external system adds a message, so it
 * is where the interesting validation lives: the clinic is resolved from the
 * provider's phone-number id, never from the request body, and the sender
 * number is what identifies the patient. A caller cannot post a message into
 * another clinic by putting someone else's phone number in the payload.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { isValidE164, normalizePhone } from '@mediflow/shared';

import {
  ApiError,
  handler,
  idSchema,
  paginationSchema,
  parseBody,
  parseQuery, parseParams } from '../http/errors.js';
import { requireCapability } from '../auth/plugin.js';
import { clinicTimezone, readSettings } from '../services/settings.js';
import { tenantOf, userIdOf } from '../services/context.js';
import { toMessage, toMessageThread, toOutboxMessage, type Row } from '../db/mappers.js';
import { queueOutbound } from '../services/outbox.js';
import { createMessage, ensureThread, threadKey } from '../services/threads.js';
import { normalizeSender, processInbound, resolveClinicForProvider } from '../services/inbound.js';

const sendSchema = z.object({
  patientId: idSchema,
  body: z.string().trim().min(1).max(4096),
  channel: z.enum(['whatsapp', 'sms', 'email', 'in_app']).default('whatsapp'),
  appointmentId: idSchema.nullable().optional(),
  replyToMessageId: idSchema.nullable().optional(),
});

const recallSchema = z.object({
  patientId: idSchema,
  body: z.string().trim().min(1).max(4096),
  followUpId: idSchema.nullable().optional(),
});

const inboundSchema = z.object({
  /** Provider account the message arrived on. Resolves the clinic. */
  phoneNumberId: z.string().trim().min(1).max(64),
  from: z.string().trim().min(6).max(24),
  body: z.string().trim().min(1).max(4096),
  externalMessageId: z.string().trim().min(1).max(128).optional(),
  patientName: z.string().trim().max(160).optional(),
  receivedAt: z.string().refine((v) => !Number.isNaN(Date.parse(v))).optional(),
});

export async function registerMessagingRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/threads',
    { preHandler: requireCapability('whatsapp:read') },
    handler(async (request) => {
      const query = parseQuery(
        request,
        paginationSchema.extend({ unreadOnly: z.enum(['true', 'false']).default('false') }),
      );
      const tenant = tenantOf(request);
      const clause = query.unreadOnly === 'true' ? 'unread_count > 0' : '1 = 1';
      const rows = tenant.page<Row>('message_threads', {
        where: clause,
        orderBy: 'COALESCE(last_message_at, created_at) DESC',
        limit: query.limit,
        offset: query.offset,
      });
      return {
        items: rows.map(toMessageThread),
        total: tenant.count('message_threads', clause),
        limit: query.limit,
        offset: query.offset,
      };
    }),
  );

  app.get(
    '/threads/:id/messages',
    { preHandler: requireCapability('whatsapp:read') },
    handler(async (request) => {
      const { id } = parseParams(request, z.object({ id: idSchema }));
      const tenant = tenantOf(request);
      const thread = tenant.get<Row>('message_threads', id);
      if (!thread) throw ApiError.notFound('Thread not found.');

      const items = tenant
        .page<Row>('messages', {
          where: 'thread_id = ?',
          params: [id],
          orderBy: 'created_at ASC',
          limit: 500,
          offset: 0,
        })
        .map(toMessage);
      return { thread: toMessageThread(thread), items };
    }),
  );

  app.post(
    '/threads/:id/read',
    { preHandler: requireCapability('whatsapp:read') },
    handler(async (request) => {
      const { id } = parseParams(request, z.object({ id: idSchema }));
      const tenant = tenantOf(request);
      const thread = tenant.get<Row>('message_threads', id);
      if (!thread) throw ApiError.notFound('Thread not found.');
      const now = new Date().toISOString();
      tenant.update('message_threads', id, { unread_count: 0, updated_at: now });
      tenant.all<Row>('messages', 'thread_id = ? AND read_at IS NULL', [id]).forEach((m) => {
        tenant.update('messages', String(m['id']), { read_at: now, updated_at: now });
      });
      return toMessageThread(tenant.require<Row>('message_threads', id));
    }),
  );

  /** Staff sends a message. Goes through the outbox, not the provider directly. */
  app.post(
    '/messages',
    { preHandler: requireCapability('whatsapp:write') },
    handler(async (request, reply) => {
      const body = parseBody(request, sendSchema, 'message');
      const clinicId = request.tenant.clinicId;
      const tenant = tenantOf(request);
      const settings = readSettings(app.database, clinicId);

      const patient = tenant.get<Row>('patients', body.patientId);
      if (!patient) throw ApiError.notFound('Patient not found.');

      const to = normalizePhone(
        String(patient['whatsapp_number'] ?? patient['phone']),
        settings.whatsapp.defaultDialCode,
      );
      if (!to || !isValidE164(to)) {
        throw ApiError.conflict('This patient has no valid messaging number.');
      }

      const now = new Date().toISOString();
      // Marketing consent is the patient's `marketing_opt_in`; a staff-initiated
      // care message is allowed on `whatsapp_opt_in` alone.
      const isMarketing = false;
      if (isMarketing && !Number(patient['marketing_opt_in'])) {
        throw ApiError.forbidden('This patient has not opted in to marketing messages.');
      }
      if (!Number(patient['whatsapp_opt_in'])) {
        throw ApiError.forbidden('This patient has opted out of WhatsApp messages.');
      }

      const queued = queueOutbound(tenant, {
        to,
        body: body.body,
        template: 'custom',
        channel: body.channel,
        patientId: body.patientId,
        appointmentId: body.appointmentId ?? null,
        now,
      });

      // One thread per patient per channel, matching the inbound path so a
      // staff reply and the patient's own message land in the same conversation.
      const threadId = ensureThread(
        tenant,
        clinicId,
        body.patientId,
        threadKey(body.patientId, body.channel),
        body.body,
        now,
        false,
      );
      const message = createMessage(tenant, clinicId, {
        threadId,
        patientId: body.patientId,
        channel: body.channel,
        direction: 'outbound',
        // `queued`, not `sent`: nothing has reached the provider yet. The
        // status webhook moves it to sent/delivered/read.
        status: 'queued',
        body: body.body,
        sentBy: userIdOf(request),
        appointmentId: body.appointmentId ?? null,
        replyToMessageId: body.replyToMessageId ?? null,
        now,
      });

      return reply.status(201).send({ message, outbox: queued.message, enqueued: queued.enqueued });
    }),
  );

  app.get(
    '/outbox',
    { preHandler: requireCapability('whatsapp:read') },
    handler(async (request) => {
      const query = parseQuery(
        request,
        paginationSchema.extend({
          status: z.enum(['pending', 'processing', 'sent', 'failed', 'dead']).optional(),
        }),
      );
      const tenant = tenantOf(request);
      const where = query.status ? 'status = ?' : '1 = 1';
      const params = query.status ? [query.status] : [];
      const rows = tenant.page<Row>('outbox', {
        where,
        params,
        orderBy: 'priority ASC, scheduled_for ASC',
        limit: query.limit,
        offset: query.offset,
      });
      return {
        items: rows.map(toOutboxMessage),
        counts: {
          pending: tenant.count('outbox', "status IN ('pending', 'processing')"),
          failed: tenant.count('outbox', "status = 'failed'"),
          dead: tenant.count('outbox', "status = 'dead'"),
        },
        limit: query.limit,
        offset: query.offset,
      };
    }),
  );

  /**
   * Batch recall queue: the doctor reviews the due list, then enqueues one row
   * per ticked patient.
   *
   * The opt-in check is re-read here rather than trusted from the list the
   * doctor reviewed: a patient can opt out between the scan and the send, and
   * consent is the one thing that must never go stale. `skipped` is a normal
   * outcome, not an error, so the caller can report "3 queued, 1 skipped".
   *
   * `dedupeKey` carries the follow-up id and the day, so pressing the button
   * twice cannot message a patient twice on the same day; the unique index on
   * (clinic_id, dedupe_key) is what actually guarantees it.
   */
  app.post(
    '/outbox/recall',
    { preHandler: requireCapability('whatsapp:write') },
    handler(async (request) => {
      const body = parseBody(request, recallSchema, 'recall');
      const tenant = tenantOf(request);
      const patient = tenant.get<Row>('patients', body.patientId);
      if (!patient) throw ApiError.notFound('Patient not found.');

      // Consent gate. An opted-out patient is reported, never silently sent.
      if (!patient['whatsapp_opt_in']) {
        return { queued: false, reason: 'opted-out' as const };
      }
      // A number that is missing or not E.164 is a data problem, not a send:
      // report it rather than queueing a row the gateway can never deliver.
      const to = normalizePhone(String(patient['whatsapp_number'] ?? patient['phone'] ?? ''));
      if (!to || !isValidE164(to)) {
        return { queued: false, reason: 'no-phone' as const };
      }

      const now = new Date().toISOString();
      const result = queueOutbound(tenant, {
        to,
        body: body.body,
        template: 'followup_checkin',
        channel: 'whatsapp',
        patientId: body.patientId,
        dedupeKey: `recall:${body.followUpId ?? body.patientId}:${now.slice(0, 10)}`,
        now,
      });
      return { queued: true, reason: 'ok' as const, enqueued: result.enqueued };
    }),
  );

  /**
   * Manual click-to-send (P2): the doctor opens the message in the WhatsApp
   * app (wa.me link) and presses send there. This endpoint records that human
   * press so the row leaves the pending queue and the thread shows `sent`
   * instead of `queued`. Only actionable rows qualify; anything already sent
   * (or dead) is rejected so history cannot be rewritten.
   */
  app.post(
    '/outbox/:id/manual-send',
    { preHandler: requireCapability('whatsapp:write') },
    handler(async (request) => {
      const { id } = parseParams(request, z.object({ id: idSchema }));
      const tenant = tenantOf(request);
      const row = tenant.get<Row>('outbox', id);
      if (!row) throw ApiError.notFound('Outbox message not found.');
      const status = String(row['status'] ?? '');
      if (status === 'sent') return toOutboxMessage(row);
      if (!['pending', 'processing', 'failed'].includes(status)) {
        throw ApiError.conflict(`Only pending, processing, or failed messages can be sent manually (is ${status}).`);
      }
      const now = new Date().toISOString();
      tenant.update('outbox', id, {
        status: 'sent',
        sent_at: now,
        provider_message_id: 'manual:wa.me',
        last_error: null,
        updated_at: now,
      });
      // Mirror onto the queued thread message(s) with the same patient + body
      // so the conversation view agrees with the outbox.
      const patientId = String(row['patient_id'] ?? '');
      const body = String(row['body'] ?? '');
      if (patientId && body) {
        const queued = tenant.all<Row>('messages', "patient_id = ? AND status = 'queued' AND body = ?", [
          patientId,
          body,
        ]);
        for (const message of queued) {
          tenant.update('messages', String(message['id']), { status: 'sent', updated_at: now });
        }
      }
      return toOutboxMessage(tenant.require<Row>('outbox', id));
    }),
  );

  /**
   * Provider webhook.
   *
   * The clinic comes from `phoneNumberId`; the sender number only ever
   * identifies a patient *within* that clinic.
   */
  app.post(
    '/webhooks/whatsapp',
    { config: { public: true } },
    handler(async (request, reply) => {
      const body = parseBody(request, inboundSchema, 'inbound message');
      const clinicId = resolveClinicForProvider(app.database, body.phoneNumberId);
      const tenant = app.tenantFor(clinicId);
      const settings = readSettings(app.database, clinicId);
      const timeZone = clinicTimezone(app.database, clinicId);

      const from = normalizeSender(body.from, settings.whatsapp.defaultDialCode);

      const result = processInbound({
        db: app.database,
        tenant,
        clinicId,
        from,
        body: body.body,
        defaultDialCode: settings.whatsapp.defaultDialCode,
        clinicTimezone: timeZone,
        criticalValueAlerts: settings.features.criticalValueAlerts,
        patientName: body.patientName,
        externalMessageId: body.externalMessageId,
        receivedAt: body.receivedAt,
      });

      // 202 on success so the provider stops retrying; a duplicate also 202s,
      // because the message *is* stored, the first delivery just already did it.
      return reply.status(202).send(result);
    }),
  );

  app.post(
    '/webhooks/whatsapp/status',
    { config: { public: true } },
    handler(async (request) => {
      const body = parseBody(
        request,
        z.object({
          providerMessageId: z.string().trim().min(1).max(128),
          status: z.enum(['delivered', 'read', 'failed']),
          error: z.string().trim().max(300).optional(),
        }),
        'delivery status',
      );

      const now = new Date().toISOString();
      // A status update identifies the message by its provider id, which is
      // stored on both the outbox row (send result) and the message row
      // (conversation view). They are updated together, and the outbox row is
      // the one that drives the retry policy.
      //
      // The lookup crosses clinics on purpose: the provider does not say which
      // clinic a callback belongs to. `provider_message_id` is globally unique
      // and written only by this API, so the match is unambiguous - and no
      // request-supplied clinic id is trusted here.
      const outbox = app.database
        .prepare(
          'SELECT clinic_id, id, status, attempts, max_attempts FROM outbox WHERE provider_message_id = ? LIMIT 1',
        )
        .get(body.providerMessageId) as
        | { clinic_id: string; id: string; status: string; attempts: number; max_attempts: number }
        | undefined;

      const message = app.database
        .prepare('SELECT clinic_id, id, status FROM messages WHERE provider_message_id = ? LIMIT 1')
        .get(body.providerMessageId) as
        | { clinic_id: string; id: string; status: string }
        | undefined;

      if (outbox) {
        const tenant = app.tenantFor(outbox.clinic_id);
        const outboxValues: Record<string, string | number> = { updated_at: now };

        if (body.status === 'failed') {
          // A provider-side failure is retried only while attempts remain, then
          // dead-lettered so it stops consuming worker capacity.
          outboxValues['last_error'] = body.error ?? 'Provider reported a failure.';
          outboxValues['status'] = Number(outbox.attempts) >= Number(outbox.max_attempts) ? 'dead' : 'failed';
        } else if (outbox.status !== 'sent') {
          // delivered/read implies the send already happened; `sent_at` is
          // written by the worker and must not be overwritten here.
          outboxValues['status'] = 'sent';
        }
        tenant.update('outbox', outbox.id, outboxValues);
      }

      if (message) {
        const tenant = app.tenantFor(message.clinic_id);
        const values: Record<string, string | null> = { status: body.status, updated_at: now };
        if (body.status === 'delivered') values['delivered_at'] = now;
        if (body.status === 'read') values['read_at'] = now;
        if (body.status === 'failed') values['error'] = body.error ?? 'Provider reported a failure.';
        tenant.update('messages', message.id, values);
      }

      return { ok: true, matched: Boolean(outbox || message) };
    }),
  );
}

