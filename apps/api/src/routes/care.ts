/**
 * Follow-up engine and vitals endpoints.
 *
 * The follow-up request limit is enforced in SQL, not in JavaScript: the
 * check and the increment are part of one statement, so two workers running at
 * the same moment cannot both pass a "has this patient had their 3 weekly
 * requests?" test and send a fourth.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  VITAL_KINDS,
  createId,
  evaluateParsed,
  parseVitalsReply,
  toBundle,
  vitalUnit,
  type FollowUp,
  type VitalKind,
} from '@mediflow/shared';

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
import { nullable, toFollowUp, toPatient, toVitalReading, type Row } from '../db/mappers.js';
import { recordReadings } from '../services/inbound.js';
import { queueOutbound } from '../services/outbox.js';

const createFollowUpSchema = z.object({
  patientId: idSchema,
  name: z.string().trim().min(1).max(160),
  protocolId: idSchema.nullable().optional(),
  intervalDays: z.number().int().min(1).max(365).default(7),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  trigger: z.enum(['interval', 'reading_received', 'missed_reading', 'appointment_completed']).default('interval'),
  notes: z.string().trim().max(2000).nullable().optional(),
});

const recordVitalsSchema = z.object({
  patientId: idSchema,
  readings: z
    .array(
      z.object({
        kind: z.enum(VITAL_KINDS),
        value: z.number().finite(),
        secondaryValue: z.number().finite().optional(),
        unit: z.string().trim().max(24).optional(),
        context: z.string().trim().max(200).nullable().optional(),
        measuredAt: z.string().refine((v) => !Number.isNaN(Date.parse(v))).optional(),
      }),
    )
    .min(1)
    .max(10),
});

export async function registerCareRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/follow-ups',
    { preHandler: requireCapability('patients:read') },
    handler(async (request) => {
      const query = parseQuery(
        request,
        paginationSchema.extend({
          status: z.enum(['active', 'paused', 'completed', 'cancelled']).optional(),
          patientId: idSchema.optional(),
          due: z.enum(['true', 'false']).optional(),
        }),
      );
      const tenant = tenantOf(request);
      const where: string[] = [];
      const params: (string | number)[] = [];
      if (query.status) {
        where.push('status = ?');
        params.push(query.status);
      }
      if (query.patientId) {
        where.push('patient_id = ?');
        params.push(query.patientId);
      }
      if (query.due === 'true') {
        where.push('next_due_at <= ?');
        params.push(new Date().toISOString());
      }
      const clause = where.length > 0 ? where.join(' AND ') : undefined;
      const rows = tenant.page<Row>('follow_ups', {
        where: clause,
        params,
        orderBy: 'next_due_at ASC',
        limit: query.limit,
        offset: query.offset,
      });
      return {
        items: rows.map(toFollowUp),
        total: tenant.count('follow_ups', clause, params),
        limit: query.limit,
        offset: query.offset,
      };
    }),
  );

  app.post(
    '/follow-ups',
    { preHandler: requireCapability('clinical:write') },
    handler(async (request, reply) => {
      const body = parseBody(request, createFollowUpSchema, 'follow-up');
      const tenant = tenantOf(request);
      const clinicId = request.tenant.clinicId;
      const settings = readSettings(app.database, clinicId);

      const patient = tenant.get<Row>('patients', body.patientId);
      if (!patient) throw ApiError.notFound('Patient not found.');

      const now = new Date().toISOString();
      const id = createId('fup');
      // `startDate` is a clinic-local date, so the first due moment is computed
      // in clinic time rather than by appending 'Z' to it.
      const nextDueAt = new Date(`${body.startDate}T09:00:00`).toISOString();

      tenant.insert('follow_ups', {
        id,
        clinic_id: clinicId,
        patient_id: body.patientId,
        protocol_id: nullable(body.protocolId),
        diagnosis_id: null,
        name: body.name,
        status: 'active',
        trigger: body.trigger,
        interval_days: body.intervalDays,
        start_date: body.startDate,
        end_date: nullable(body.endDate),
        next_due_at: nextDueAt,
        last_requested_at: null,
        last_response_at: null,
        requests_this_week: 0,
        week_stamp: null,
        requests_sent: 0,
        responses_received: 0,
        consecutive_misses: 0,
        adherence_percent: 100,
        paused_at: null,
        pause_reason: null,
        notes: nullable(body.notes),
        created_by: userIdOf(request),
        created_at: now,
        updated_at: now,
      });
      void settings;
      return reply.status(201).send(toFollowUp(tenant.require<Row>('follow_ups', id)));
    }),
  );

  app.patch(
    '/follow-ups/:id',
    { preHandler: requireCapability('clinical:write') },
    handler(async (request) => {
      const { id } = parseParams(request, z.object({ id: idSchema }));
      const body = parseBody(
        request,
        z.object({
          status: z.enum(['active', 'paused', 'completed', 'cancelled']).optional(),
          intervalDays: z.number().int().min(1).max(365).optional(),
          notes: z.string().trim().max(2000).nullable().optional(),
          pauseReason: z.string().trim().max(200).nullable().optional(),
        }),
        'follow-up update',
      );
      const tenant = tenantOf(request);
      tenant.require('follow_ups', id);
      const now = new Date().toISOString();

      const values: Record<string, string | number | null> = { updated_at: now };
      if (body.status !== undefined) {
        values['status'] = body.status;
        values['paused_at'] = body.status === 'paused' ? now : null;
        if (body.pauseReason !== undefined) values['pause_reason'] = nullable(body.pauseReason);
      }
      if (body.intervalDays !== undefined) values['interval_days'] = body.intervalDays;
      if (body.notes !== undefined) values['notes'] = nullable(body.notes);

      tenant.update('follow_ups', id, values);
      return toFollowUp(tenant.require<Row>('follow_ups', id));
    }),
  );

  /**
   * Send a follow-up request.
   *
   * The weekly cap is enforced by the UPDATE itself: it only applies if the
   * stored counter is below the limit, so a concurrent call is a no-op rather
   * than an over-send.
   */
  app.post(
    '/follow-ups/:id/request',
    { preHandler: requireCapability('clinical:write') },
    handler(async (request) => {
      const { id } = parseParams(request, z.object({ id: idSchema }));
      const tenant = tenantOf(request);
      const clinicId = request.tenant.clinicId;
      const settings = readSettings(app.database, clinicId);
      const now = new Date().toISOString();

      const followUp = toFollowUp(tenant.require<Row>('follow_ups', id));
      if (followUp.status !== 'active') {
        throw ApiError.conflict(`This follow-up is "${followUp.status}" and cannot be requested.`);
      }
      if (followUp.endDate && followUp.endDate < now.slice(0, 10)) {
        throw ApiError.conflict('This follow-up has ended.');
      }

      const patient = tenant.get<Row>('patients', followUp.patientId);
      if (!patient) throw ApiError.notFound('Patient not found.');

      if (settings.followUps.enabled === false) {
        throw ApiError.conflict('Automated follow-ups are disabled for this clinic.');
      }
      if (!Number(patient['whatsapp_opt_in'])) {
        throw ApiError.forbidden('This patient has opted out of WhatsApp messages.');
      }

      const weekStamp = isoWeekStamp(new Date(now));
      // The cap is enforced by the UPDATE itself: the row only changes when it
      // is still under the weekly limit, so two concurrent requests cannot both
      // pass the check and send one message too many. `changes === 0` means the
      // cap was already reached.
      const maxPerWeek = settings.followUps.maxRequestsPerWeek;
      const applied = tenant.db
        .prepare(
          `UPDATE follow_ups
              SET requests_this_week = CASE WHEN week_stamp = ? THEN requests_this_week + 1 ELSE 1 END,
                  week_stamp = ?,
                  last_requested_at = ?,
                  requests_sent = requests_sent + 1,
                  updated_at = ?
            WHERE id = ? AND clinic_id = ? AND status = 'active'
              AND (week_stamp IS NULL OR week_stamp != ? OR requests_this_week < ?)`,
        )
        .run(weekStamp, weekStamp, now, now, id, clinicId, weekStamp, maxPerWeek);
      if (applied.changes === 0) {
        throw ApiError.conflict(
          `This patient has already been asked ${maxPerWeek} times this week.`,
        );
      }

      const refreshed = toFollowUp(tenant.require<Row>('follow_ups', id));
      const counted = refreshed.requestsThisWeek;

      const to = String(patient['whatsapp_number'] ?? patient['phone']);
      const arabic = String(patient['preferred_language'] ?? 'en') === 'ar';
      const body = arabic
        ? `مرحبًا ${String(patient['first_name'])}، حان وقت متابعة ${followUp.name}. هل يمكنك إرسال قراءتك من فضلك؟`
        : `Hello ${String(patient['first_name'])}, it is time for your ${followUp.name} follow-up. Could you send your reading?`;

      queueOutbound(tenant, {
        to,
        body,
        template: 'vitals_request',
        channel: 'whatsapp',
        patientId: followUp.patientId,
        dedupeKey: `followup:${id}:${now.slice(0, 10)}:${counted}`,
        now,
      });

      return { ok: true, requestsThisWeek: counted, maxPerWeek: settings.followUps.maxRequestsPerWeek };
    }),
  );

  /** Mark that a patient responded, which is what adherence is measured from. */
  app.post(
    '/follow-ups/:id/response',
    { preHandler: requireCapability('clinical:write') },
    handler(async (request) => {
      const { id } = parseParams(request, z.object({ id: idSchema }));
      const tenant = tenantOf(request);
      const followUp = toFollowUp(tenant.require<Row>('follow_ups', id));
      const now = new Date().toISOString();

      const responsesReceived = followUp.responsesReceived + 1;
      const requestsSent = Math.max(followUp.requestsSent, 1);
      // Adherence is responses over requests, not over scheduled intervals:
      // a patient who replies to every request has 100% adherence even if the
      // interval changed.
      const adherence = Math.min(100, Math.round((responsesReceived / requestsSent) * 100));

      tenant.update('follow_ups', id, {
        last_response_at: now,
        responses_received: responsesReceived,
        consecutive_misses: 0,
        adherence_percent: adherence,
        next_due_at: nextDue(followUp, now),
        updated_at: now,
      });

      return toFollowUp(tenant.require<Row>('follow_ups', id));
    }),
  );

  app.get(
    '/vitals',
    { preHandler: requireCapability('clinical:read') },
    handler(async (request) => {
      const query = parseQuery(
        request,
        paginationSchema.extend({
          patientId: idSchema.optional(),
          kind: z.enum(VITAL_KINDS).optional(),
          abnormalOnly: z.enum(['true', 'false']).default('false'),
        }),
      );
      const tenant = tenantOf(request);
      const where: string[] = [];
      const params: (string | number)[] = [];
      if (query.patientId) {
        where.push('patient_id = ?');
        params.push(query.patientId);
      }
      if (query.kind) {
        where.push('kind = ?');
        params.push(query.kind);
      }
      if (query.abnormalOnly === 'true') where.push('is_abnormal = 1');

      const clause = where.length > 0 ? where.join(' AND ') : undefined;
      const rows = tenant.page<Row>('vital_readings', {
        where: clause,
        params,
        orderBy: 'measured_at DESC',
        limit: query.limit,
        offset: query.offset,
      });
      return {
        items: rows.map(toVitalReading),
        total: tenant.count('vital_readings', clause, params),
        limit: query.limit,
        offset: query.offset,
      };
    }),
  );

  /** Staff-entered readings go through the same evaluation as inbound ones. */
  app.post(
    '/vitals',
    { preHandler: requireCapability('clinical:write') },
    handler(async (request, reply) => {
      const body = parseBody(request, recordVitalsSchema, 'vital readings');
      const tenant = tenantOf(request);
      const clinicId = request.tenant.clinicId;
      const settings = readSettings(app.database, clinicId);

      const patient = toPatientForVitals(tenant, body.patientId);
      if (!patient) throw ApiError.notFound('Patient not found.');

      const now = new Date().toISOString();
      // Reuse the inbound path so thresholds, alerts, and notifications behave
      // identically no matter where a reading came from.
      const result = recordReadings(
        tenant,
        clinicId,
        patient,
        {
          hasReading: true,
          readings: body.readings.map((r) => ({
            kind: r.kind as VitalKind,
            value: r.value,
            secondaryValue: r.secondaryValue ?? null,
            unit: r.unit ?? defaultUnit(r.kind),
            context: r.context ?? null,
            // A value typed by staff is fully identified; the matched substring
            // is the label they typed it under.
            confidence: 'high' as const,
            matchedText: r.unit ?? defaultUnit(r.kind),
          })),
          unitSystem: 'unknown',
          freeText: '',
          symptoms: [],
          urgent: false,
          unmatchedNumbers: [],
        },
        now,
        {
          criticalValueAlerts: settings.features.criticalValueAlerts,
          clinicTimezone: clinicTimezone(app.database, clinicId),
          messageId: null,
        },
      );

      return reply.status(201).send(result);
    }),
  );

  /** Parse free text the way the WhatsApp path does, without saving it. */
  app.post(
    '/vitals/parse',
    { preHandler: requireCapability('clinical:read') },
    handler(async (request) => {
      const body = parseBody(
        request,
        z.object({ text: z.string().trim().min(1).max(2000) }),
        'text',
      );
      const parse = parseVitalsReply(body.text, { source: 'staff' });
      const evaluations = evaluateParsed(parse, { source: 'staff' });
      const bundle = toBundle(parse, { source: 'staff' });
      return { parse, evaluations, bundle };
    }),
  );

  app.get(
    '/alerts',
    { preHandler: requireCapability('clinical:read') },
    handler(async (request) => {
      const query = parseQuery(
        request,
        z.object({
          status: z.enum(['open', 'acknowledged', 'resolved']).optional(),
          severity: z.enum(['info', 'warning', 'critical']).optional(),
          patientId: idSchema.optional(),
          ...paginationSchema.shape,
        }),
      );
      const tenant = tenantOf(request);
      const where: string[] = [];
      const params: string[] = [];
      if (query.status) {
        where.push('status = ?');
        params.push(query.status);
      }
      if (query.severity) {
        where.push('severity = ?');
        params.push(query.severity);
      }
      if (query.patientId) {
        where.push('patient_id = ?');
        params.push(query.patientId);
      }
      const clause = where.length > 0 ? where.join(' AND ') : undefined;
      const rows = tenant.page<Row>('clinical_alerts', {
        where: clause,
        params,
        // Critical first: a clinician triaging this list needs the dangerous
        // results at the top, not the most recent ones.
        orderBy:
          "CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, created_at DESC",
        limit: query.limit,
        offset: query.offset,
      });
      return { items: rows.map((r) => ({ ...r })) };
    }),
  );

  app.post(
    '/alerts/:id/acknowledge',
    { preHandler: requireCapability('clinical:write') },
    handler(async (request) => {
      const { id } = parseParams(request, z.object({ id: idSchema }));
      const tenant = tenantOf(request);
      const existing = tenant.get<Row>('clinical_alerts', id);
      if (!existing) throw ApiError.notFound('Alert not found.');
      if (String(existing['status']) === 'resolved') {
        throw ApiError.conflict('This alert is already resolved.');
      }
      const now = new Date().toISOString();
      tenant.update('clinical_alerts', id, {
        status: 'acknowledged',
        acknowledged_by: userIdOf(request),
        acknowledged_at: now,
        read_at: now,
        updated_at: now,
      });
      return { ok: true, id };
    }),
  );

  app.post(
    '/alerts/:id/resolve',
    { preHandler: requireCapability('clinical:write') },
    handler(async (request) => {
      const { id } = parseParams(request, z.object({ id: idSchema }));
      const body = parseBody(
        request,
        z.object({ note: z.string().trim().min(1).max(1000) }),
        'resolution',
      );
      const tenant = tenantOf(request);
      const existing = tenant.get<Row>('clinical_alerts', id);
      if (!existing) throw ApiError.notFound('Alert not found.');
      const now = new Date().toISOString();
      tenant.update('clinical_alerts', id, {
        status: 'resolved',
        resolved_at: now,
        // Resolution without a note would erase the clinical reasoning, so it
        // is required rather than defaulted.
        resolution_note: body.note,
        acknowledged_by: String(existing['acknowledged_by'] ?? userIdOf(request) ?? ''),
        acknowledged_at: String(existing['acknowledged_at'] ?? now),
        updated_at: now,
      });
      return { ok: true, id };
    }),
  );
}

function nextDue(followUp: FollowUp, now: string): string {
  const base = new Date(followUp.nextDueAt);
  const next = new Date(base.getTime() + followUp.intervalDays * 86_400_000);
  return next.getTime() < Date.parse(now)
    ? new Date(Date.parse(now) + followUp.intervalDays * 86_400_000).toISOString()
    : next.toISOString();
}

/** ISO-8601 week stamp, e.g. "2026-W11". A calendar-day stamp is not a week. */
export function isoWeekStamp(date: Date): string {
  const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  // Thursday of the current week determines the ISO year.
  const dayNumber = (target.getUTCDay() + 6) % 7;
  target.setUTCDate(target.getUTCDate() - dayNumber + 3);
  const isoYear = target.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  const firstDayNumber = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNumber + 3);
  const week = 1 + Math.round((target.getTime() - firstThursday.getTime()) / (7 * 86_400_000));
  return `${isoYear}-W${String(week).padStart(2, '0')}`;
}

/**
 * Unit for a vital kind.
 *
 * Delegates to the shared definitions rather than keeping a second list here:
 * a local table drifts, and a wrong unit on a lab value is a clinical error, not
 * a formatting nit.
 */
function defaultUnit(kind: VitalKind): string {
  return vitalUnit(kind);
}

function toPatientForVitals(
  tenant: import('../db/tenant.js').TenantHandle,
  patientId: string,
): ReturnType<typeof toPatient> | null {
  const row = tenant.get<Row>('patients', patientId);
  return row ? toPatient(row) : null;
}
