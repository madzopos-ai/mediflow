/**
 * Waitlist endpoints.
 *
 * Ranking uses the shared engine's `rankCandidates`, so the order patients see in
 * the app and the order the auto-filler uses are the same function - one
 * definition of "who gets the freed slot".
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { dateKeyInTz, rankCandidates, toIso, addMinutes, type Slot } from '@mediflow/shared';

import { ApiError, handler, idSchema, parseBody, parseQuery, parseParams } from '../http/errors.js';
import { requireCapability } from '../auth/plugin.js';
import { tenantOf, userIdOf } from '../services/context.js';
import { clinicTimezone } from '../services/settings.js';
import { jsonColumn, nullable, toWaitlistEntry, type Row } from '../db/mappers.js';
import { createBooking } from '../services/appointments.js';
import { bookingContextFor } from '../services/appointments.js';

/** `HH:mm` wall-clock time in the clinic's timezone, for slot comparisons. */
function toZoned(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone,
  }).format(instant);
}

const createSchema = z.object({
  patientId: idSchema,
  specialty: z.string().trim().max(60).default('general_medicine'),
  doctorId: idSchema.nullable().optional(),
  preferredDateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  preferredDateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  preferredTimeWindows: z
    .array(
      z.object({
        start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
        end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
      }),
    )
    .max(5)
    .optional(),
  note: z.string().trim().max(500).nullable().optional(),
  priority: z.number().int().min(0).max(100).default(0),
});

export async function registerWaitlistRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/waitlist',
    { preHandler: requireCapability('appointments:read') },
    handler(async (request) => {
      const query = parseQuery(
        request,
        z.object({
          status: z.enum(['waiting', 'offered', 'booked', 'expired', 'cancelled']).optional(),
          specialty: z.string().trim().max(60).optional(),
        }),
      );
      const tenant = tenantOf(request);
      const where: string[] = [];
      const params: string[] = [];
      if (query.status) {
        where.push('status = ?');
        params.push(query.status);
      }
      if (query.specialty) {
        where.push('specialty = ?');
        params.push(query.specialty);
      }
      const rows = tenant.page<Row>('waitlist', {
        where: where.length > 0 ? where.join(' AND ') : undefined,
        params,
        orderBy: 'priority DESC, created_at ASC',
        limit: 200,
        offset: 0,
      });
      return { items: rows.map(toWaitlistEntry) };
    }),
  );

  app.get(
    '/waitlist/ranked',
    { preHandler: requireCapability('appointments:read') },
    handler(async (request) => {
      const query = parseQuery(
        request,
        z.object({
          slot: z.string().refine((v) => !Number.isNaN(Date.parse(v)), 'Must be an ISO timestamp.'),
          durationMinutes: z.coerce.number().int().min(5).max(480).default(20),
          specialty: z.string().trim().max(60).optional(),
        }),
      );
      const tenant = tenantOf(request);
      const timeZone = clinicTimezone(app.database, request.tenant.clinicId);
      const entries = tenant
        .all<Row>('waitlist', "status = 'waiting'")
        .map(toWaitlistEntry)
        .filter((e) => !query.specialty || e.specialty === query.specialty);

      // Local wall-clock fields are derived from the clinic's timezone, not from
      // the UTC string. For a clinic at UTC+3 a 09:00 local booking is 06:00Z,
      // and a window built from the raw string would not match the entry.
      const startsAt = new Date(query.slot);
      const slot: Slot = {
        startsAt: startsAt.toISOString(),
        endsAt: toIso(addMinutes(startsAt, query.durationMinutes)),
        dateKey: dateKeyInTz(startsAt, timeZone),
        localStart: toZoned(startsAt, timeZone),
        localEnd: toZoned(addMinutes(startsAt, query.durationMinutes), timeZone),
        durationMinutes: query.durationMinutes,
      };

      // `rankCandidates` is pure, so staff can preview the queue order for a
      // freed slot without the auto-filler having to commit to anything.
      const ranked = rankCandidates(entries, { slot, now: new Date().toISOString() });
      return {
        slot,
        ranked: ranked.matches,
        rejected: ranked.rejected,
      };
    }),
  );

  app.post(
    '/waitlist',
    { preHandler: requireCapability('appointments:write') },
    handler(async (request, reply) => {
      const body = parseBody(request, createSchema, 'waitlist entry');
      const tenant = tenantOf(request);
      const clinicId = request.tenant.clinicId;

      const patient = tenant.get<Row>('patients', body.patientId);
      if (!patient) throw ApiError.notFound('Patient not found.');

      // A patient already waiting for the same specialty should update the
      // existing entry rather than appear twice in the queue.
      const existing = tenant.find<Row>(
        'waitlist',
        'patient_id = ? AND specialty = ? AND status IN (?, ?)',
        [body.patientId, body.specialty, 'waiting', 'offered'],
      );
      if (existing) {
        throw ApiError.conflict('This patient is already on the waitlist for that specialty.', {
          id: String(existing['id']),
        });
      }

      const now = new Date().toISOString();
      const id = `wl_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
      tenant.insert('waitlist', {
        id,
        clinic_id: clinicId,
        patient_id: body.patientId,
        specialty: body.specialty,
        doctor_id: nullable(body.doctorId),
        preferred_date_from: nullable(body.preferredDateFrom),
        preferred_date_to: nullable(body.preferredDateTo),
        preferred_time_windows: jsonColumn(body.preferredTimeWindows ?? []),
        note: nullable(body.note),
        priority: body.priority,
        status: 'waiting',
        offered_appointment_id: null,
        offered_slot_start: null,
        offered_slot_end: null,
        offer_expires_at: null,
        offers: 0,
        last_offered_at: null,
        patient_name: String(patient['full_name']),
        patient_phone: String(patient['phone']),
        created_at: now,
        updated_at: now,
      });

      return reply.status(201).send(toWaitlistEntry(tenant.require<Row>('waitlist', id)));
    }),
  );

  app.patch(
    '/waitlist/:id',
    { preHandler: requireCapability('appointments:write') },
    handler(async (request) => {
      const { id } = parseParams(request, z.object({ id: idSchema }));
      const body = parseBody(
        request,
        z.object({
          status: z.enum(['waiting', 'offered', 'booked', 'expired', 'cancelled']).optional(),
          priority: z.number().int().min(0).max(100).optional(),
          note: z.string().trim().max(500).nullable().optional(),
        }),
        'waitlist update',
      );
      const tenant = tenantOf(request);
      const existing = toWaitlistEntry(tenant.require<Row>('waitlist', id));

      const values: Record<string, string | number | null> = {
        updated_at: new Date().toISOString(),
      };
      if (body.status !== undefined) values['status'] = body.status;
      if (body.priority !== undefined) values['priority'] = body.priority;
      if (body.note !== undefined) values['note'] = nullable(body.note);
      // Leaving the waiting state must clear any stale offer.
      if (body.status && body.status !== 'offered') {
        values['offered_appointment_id'] = null;
        values['offered_slot_start'] = null;
        values['offered_slot_end'] = null;
        values['offer_expires_at'] = null;
      }
      void existing;

      tenant.update('waitlist', id, values);
      return toWaitlistEntry(tenant.require<Row>('waitlist', id));
    }),
  );

  /** Convert an offer into a real booking. */
  app.post(
    '/waitlist/:id/book',
    { preHandler: requireCapability('appointments:write') },
    handler(async (request) => {
      const { id } = parseParams(request, z.object({ id: idSchema }));
      const tenant = tenantOf(request);
      const clinicId = request.tenant.clinicId;
      const entry = toWaitlistEntry(tenant.require<Row>('waitlist', id));

      if (entry.status !== 'offered' || !entry.offeredSlotStart) {
        throw ApiError.conflict('This waitlist entry has no active offer.');
      }
      if (entry.offerExpiresAt && entry.offerExpiresAt <= new Date().toISOString()) {
        tenant.update('waitlist', id, {
          status: 'waiting',
          offered_appointment_id: null,
          offered_slot_start: null,
          offered_slot_end: null,
          offer_expires_at: null,
          updated_at: new Date().toISOString(),
        });
        throw ApiError.conflict('That offer has expired.');
      }

      const ctx = bookingContextFor(app.database, clinicId);
      const appointment = createBooking(
        app.database,
        tenant,
        clinicId,
        ctx,
        {
          patientId: entry.patientId,
          patientName: entry.patientName,
          patientPhone: entry.patientPhone,
          startsAt: entry.offeredSlotStart,
          specialty: entry.specialty,
          doctorId: entry.doctorId,
          reason: entry.note,
          source: 'system',
          createdBy: userIdOf(request),
        },
      );

      const now = new Date().toISOString();
      tenant.update('waitlist', id, {
        status: 'booked',
        offered_appointment_id: appointment.id,
        updated_at: now,
      });

      return { entry: toWaitlistEntry(tenant.require<Row>('waitlist', id)), appointment };
    }),
  );

  app.post(
    '/waitlist/:id/decline',
    { preHandler: requireCapability('appointments:write') },
    handler(async (request) => {
      const { id } = parseParams(request, z.object({ id: idSchema }));
      const tenant = tenantOf(request);
      tenant.require('waitlist', id);
      const now = new Date().toISOString();
      tenant.update('waitlist', id, {
        status: 'cancelled',
        offered_appointment_id: null,
        offered_slot_start: null,
        offered_slot_end: null,
        offer_expires_at: null,
        updated_at: now,
      });
      return toWaitlistEntry(tenant.require<Row>('waitlist', id));
    }),
  );
}
