/**
 * Appointment endpoints.
 *
 * Status transitions are an explicit allow-list rather than a free string, so a
 * cancelled appointment cannot be flipped back to confirmed by a stale client
 * tab, and a completed visit cannot be reopened.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  APPOINTMENT_STATUSES,
  dateKeyRange,
  diffDaysBetweenDateKeys,
  addDaysToDateKey,
  dateKeyInTz,
  formatDate,
  formatTime,
  isValidE164,
  normalizePhone,
  todayInTz,
  zonedTimeToUtc,
  type Appointment,
  type AppointmentStatus,
  type Specialty,
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
import { toAppointment, type Row } from '../db/mappers.js';
import type { Db } from '../db/index.js';
import type { TenantHandle } from '../db/tenant.js';
import {
  availableSlots,
  bookingContextFor,
  cancelAppointment,
  createBooking,
  explainDay,
  rescheduleAppointment,
} from '../services/appointments.js';
import { cancelPendingReminders, queueBookingConfirmation, scheduleAppointmentReminders } from '../services/reminders.js';
import { queueOutbound } from '../services/outbox.js';
import { syncPatientActivity } from '../services/activity.js';

const dateKey = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be yyyy-mm-dd.');

const listSchema = paginationSchema.extend({
  from: dateKey.optional(),
  to: dateKey.optional(),
  status: z.enum(APPOINTMENT_STATUSES).optional(),
  doctorId: idSchema.optional(),
  patientId: idSchema.optional(),
  dateKey: dateKey.optional(),
});

const createSchema = z.object({
  patientId: idSchema.nullable().optional(),
  patientName: z.string().trim().min(1).max(160),
  patientPhone: z.string().trim().min(6).max(24),
  startsAt: z.string().refine((v) => !Number.isNaN(Date.parse(v)), 'Must be an ISO timestamp.'),
  durationMinutes: z.number().int().min(5).max(480).optional(),
  doctorId: idSchema.nullable().optional(),
  doctorName: z.string().trim().max(120).nullable().optional(),
  specialty: z.string().trim().max(60).optional(),
  reason: z.string().trim().max(400).nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
  visitType: z.enum(['consultation', 'follow_up', 'procedure', 'teleconsult', 'review']).optional(),
  feeMinor: z.number().int().min(0).optional(),
});

const updateSchema = z.object({
  status: z.enum(APPOINTMENT_STATUSES).optional(),
  reason: z.string().trim().max(400).nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
  doctorId: idSchema.nullable().optional(),
  doctorName: z.string().trim().max(120).nullable().optional(),
});

/** Legal status transitions. Anything else is a 409. */
const TRANSITIONS: Record<AppointmentStatus, AppointmentStatus[]> = {
  pending: ['confirmed', 'cancelled'],
  scheduled: ['confirmed', 'cancelled', 'no_show'],
  confirmed: ['checked_in', 'in_progress', 'cancelled', 'no_show'],
  checked_in: ['in_progress', 'completed', 'cancelled'],
  in_progress: ['completed', 'cancelled'],
  completed: [],
  cancelled: [],
  no_show: [],
  rescheduled: ['cancelled'],
};

export /** The clinic-local calendar date an instant falls on. */
function localDateKey(instant: string, timeZone: string): string {
  return dateKeyInTz(new Date(instant), timeZone);
}

/**
 * Arabic patient notice for appointment changes (reschedule / cancel).
 *
 * Composed server-side so every channel renders the same wording, in the
 * clinic's timezone, with the clinic's Arabic name. When the change comes
 * from the clinic/doctor side it carries an apology; when the patient asked
 * for it, it is a plain confirmation with no apology.
 */
function appointmentNoticeBody(options: {
  kind: 'rescheduled' | 'cancelled';
  patientName: string;
  clinicName: string;
  oldStartsAt: string;
  newStartsAt?: string;
  reason: string | null;
  initiatedBy: 'clinic' | 'patient';
  timeZone: string;
}): string {
  const { kind, patientName, clinicName, oldStartsAt, newStartsAt, reason, initiatedBy, timeZone } = options;
  const oldWhen = `${formatDate(oldStartsAt, timeZone, 'ar')}, الساعة ${formatTime(oldStartsAt, timeZone, 'ar')}`;
  const lines = [`مرحباً ${patientName}،`, ''];
  if (kind === 'rescheduled' && newStartsAt) {
    const newWhen = `${formatDate(newStartsAt, timeZone, 'ar')}, الساعة ${formatTime(newStartsAt, timeZone, 'ar')}`;
    lines.push(`نعلمكم أنه تم تأجيل موعدكم في ${clinicName} من ${oldWhen} إلى ${newWhen}.`);
  } else {
    lines.push(`نعلمكم أنه تم إلغاء موعدكم في ${clinicName} الذي كان بتاريخ ${oldWhen}.`);
  }
  if (reason) lines.push(`السبب: ${reason}`);
  if (initiatedBy === 'clinic') {
    lines.push('نعتذر منكم عن هذا التغيير، ونشكر تفهمكم.');
  }
  lines.push('', 'للتأكيد أرسلوا YES، وإذا كان الوقت الجديد غير مناسب أرسلوا CANCEL وسنعاود الاتصال بكم.');
  return lines.join('\n');
}

interface NoticeInput {
  kind: 'rescheduled' | 'cancelled';
  oldStartsAt: string;
  reason: string | null;
  initiatedBy: 'clinic' | 'patient';
  now: string;
}

/**
 * Enqueue the change notice into the WhatsApp tasks queue (outbox, template
 * `custom`). Returns false - not an error - when the patient cannot be
 * reached (no number, opted out): the calendar change itself still stands.
 */
function enqueueAppointmentNotice(
  db: Db,
  tenant: TenantHandle,
  clinicId: string,
  appointment: Appointment,
  input: NoticeInput,
): boolean {
  const patientId = appointment.patientId;
  if (!patientId) return false;
  const patient = tenant.get<Row>('patients', patientId);
  if (!patient || !Number(patient['whatsapp_opt_in'])) return false;

  const settings = readSettings(db, clinicId);
  const to = normalizePhone(String(patient['whatsapp_number'] ?? patient['phone'] ?? ''), settings.whatsapp.defaultDialCode);
  if (!to || !isValidE164(to)) return false;

  const clinic = db.prepare('SELECT name, name_ar FROM clinics WHERE id = ?').get(clinicId) as
    | { name: string; name_ar: string | null }
    | undefined;
  const timeZone = appointment.timezone || 'UTC';
  const body = appointmentNoticeBody({
    kind: input.kind,
    patientName: appointment.patientName,
    clinicName: clinic?.name_ar ?? clinic?.name ?? '',
    oldStartsAt: input.oldStartsAt,
    newStartsAt: appointment.startsAt,
    reason: input.reason,
    initiatedBy: input.initiatedBy,
    timeZone,
  });

  queueOutbound(tenant, {
    to,
    body,
    template: 'custom',
    patientId,
    appointmentId: appointment.id,
    dedupeKey: `${input.kind}:${appointment.id}:${appointment.startsAt}`,
    now: input.now,
  });
  return true;
}

export async function registerAppointmentRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/appointments',
    { preHandler: requireCapability('appointments:read') },
    handler(async (request) => {
      const query = parseQuery(request, listSchema);
      const db = tenantOf(request);
      const timeZone = clinicTimezone(app.database, request.tenant.clinicId);

      const where: string[] = [];
      const params: (string | number)[] = [];

      if (query.from) {
        where.push('ends_at > ?');
        params.push(`${query.from}T00:00:00.000Z`);
      }
      if (query.to) {
        where.push('starts_at < ?');
        params.push(`${addDaysToDateKey(query.to, 1)}T00:00:00.000Z`);
      }
      if (query.status) {
        where.push('status = ?');
        params.push(query.status);
      }
      if (query.doctorId) {
        where.push('doctor_id = ?');
        params.push(query.doctorId);
      }
      if (query.patientId) {
        where.push('patient_id = ?');
        params.push(query.patientId);
      }

      const clause = where.length > 0 ? where.join(' AND ') : undefined;
      const rows = db.page<Row>('appointments', {
        where: clause,
        params,
        orderBy: 'starts_at ASC',
        limit: query.limit,
        offset: query.offset,
      });

      return {
        items: rows.map(toAppointment),
        timeZone,
        today: todayInTz(timeZone),
        total: db.count('appointments', clause, params),
        limit: query.limit,
        offset: query.offset,
      };
    }),
  );

  app.get(
    '/appointments/:id',
    { preHandler: requireCapability('appointments:read') },
    handler(async (request) => {
      const { id } = parseParams(request, z.object({ id: idSchema }));
      return toAppointment(tenantOf(request).require<Row>('appointments', id));
    }),
  );

  app.get(
    '/appointments/by-token/:token',
    { config: { public: true } },
    handler(async (request) => {
      const { token } = parseParams(request, z.object({ token: z.string().min(8).max(120) }));
      // The confirmation token is the only unauthenticated appointment lookup,
      // and it is scoped to the clinic the token belongs to.
      const row = app.database
        .prepare('SELECT * FROM appointments WHERE confirmation_token = ?')
        .get(token) as Row | undefined;
      if (!row) throw ApiError.notFound('Booking not found.');
      const appointment = toAppointment(row);
      // Only the fields a patient needs to see their own booking.
      return {
        id: appointment.id,
        startsAt: appointment.startsAt,
        endsAt: appointment.endsAt,
        status: appointment.status,
        patientName: appointment.patientName,
        doctorName: appointment.doctorName,
        specialty: appointment.specialty,
        reason: appointment.reason,
        depositRequiredMinor: appointment.depositRequiredMinor,
        depositPaidMinor: appointment.depositPaidMinor,
        clinicId: appointment.clinicId,
      };
    }),
  );

  app.post(
    '/appointments',
    { preHandler: requireCapability('appointments:write') },
    handler(async (request, reply) => {
      const body = parseBody(request, createSchema, 'appointment');
      const clinicId = request.tenant.clinicId;
      const ctx = bookingContextFor(app.database, clinicId);
      const tenant = tenantOf(request);

      if (body.patientId) {
        // Throws 404 if the patient belongs to another clinic.
        tenant.require('patients', body.patientId);
      }

      const appointment = createBooking(app.database, tenant, clinicId, ctx, {
        ...body,
        // `createBooking` distinguishes "walk-in, no patient record yet" from
        // "optional field omitted", so the id is normalised rather than spread.
        patientId: body.patientId ?? null,
        specialty: body.specialty as Specialty | undefined,
        createdBy: userIdOf(request),
        source: 'staff',
      });

      if (appointment.patientId) syncPatientActivity(tenant, appointment.patientId);
      return reply.status(201).send(appointment);
    }),
  );

  app.patch(
    '/appointments/:id',
    { preHandler: requireCapability('appointments:write') },
    handler(async (request) => {
      const { id } = parseParams(request, z.object({ id: idSchema }));
      const body = parseBody(request, updateSchema, 'appointment update');
      const tenant = tenantOf(request);
      const existing = toAppointment(tenant.require<Row>('appointments', id));

      if (body.status !== undefined && body.status !== existing.status) {
        const allowed = TRANSITIONS[existing.status as AppointmentStatus] ?? [];
        if (!allowed.includes(body.status as AppointmentStatus)) {
          throw ApiError.conflict(
            `Cannot move an appointment from "${existing.status}" to "${body.status}".`,
            { from: existing.status, to: body.status, allowed },
          );
        }
      }

      const now = new Date().toISOString();
      const values: Record<string, string | number | null> = { updated_at: now };
      if (body.status !== undefined) {
        values['status'] = body.status;
        if (body.status === 'checked_in') values['checked_in_at'] = now;
        if (body.status === 'completed') values['completed_at'] = now;
      }
      if (body.reason !== undefined) values['reason'] = body.reason;
      if (body.notes !== undefined) values['notes'] = body.notes;
      if (body.doctorId !== undefined) values['doctor_id'] = body.doctorId;
      if (body.doctorName !== undefined) values['doctor_name'] = body.doctorName;

      tenant.update('appointments', id, values);
      if (existing.patientId) syncPatientActivity(tenant, existing.patientId);
      const updated = toAppointment(tenant.require<Row>('appointments', id));
      if (existing.status === 'pending' && body.status === 'confirmed') {
        // A WhatsApp draft becomes real here: this is the moment the
        // confirmation goes out and reminders are planned - never before.
        const cid = request.tenant.clinicId;
        scheduleAppointmentReminders(tenant, cid, updated.id, { now });
        queueBookingConfirmation(tenant, cid, updated, now);
      }
      return updated;
    }),
  );

  app.post(
    '/appointments/:id/cancel',
    { preHandler: requireCapability('appointments:write') },
    handler(async (request) => {
      const { id } = parseParams(request, z.object({ id: idSchema }));
      const body = parseBody(
        request,
        z.object({
          reason: z.string().trim().max(400).nullable().optional(),
          initiatedBy: z.enum(['clinic', 'patient']).default('clinic'),
        }),
        'cancellation',
      );
      const clinicId = request.tenant.clinicId;
      const tenant = tenantOf(request);
      const existing = toAppointment(tenant.require<Row>('appointments', id));

      if (existing.status === 'completed' || existing.status === 'cancelled') {
        throw ApiError.conflict(`Cannot cancel an appointment that is "${existing.status}".`);
      }

      const now = new Date().toISOString();
      const appointment = cancelAppointment(tenant, id, userIdOf(request), body.reason ?? null);
      // A cancelled appointment must not keep reminding the patient about a
      // time they are no longer attending.
      cancelPendingReminders(tenant, id, now);
      if (appointment.patientId) syncPatientActivity(tenant, appointment.patientId);

      const enqueued = enqueueAppointmentNotice(app.database, tenant, clinicId, appointment, {
        kind: 'cancelled',
        oldStartsAt: existing.startsAt,
        reason: body.reason ?? null,
        initiatedBy: body.initiatedBy,
        now,
      });
      return { appointment, whatsappQueued: enqueued };
    }),
  );

  app.post(
    '/appointments/:id/reschedule',
    { preHandler: requireCapability('appointments:write') },
    handler(async (request) => {
      const { id } = parseParams(request, z.object({ id: idSchema }));
      const body = parseBody(
        request,
        z.object({
          startsAt: z.string().refine((v) => !Number.isNaN(Date.parse(v)), 'Must be an ISO timestamp.'),
          reason: z.string().trim().min(1).max(400),
          initiatedBy: z.enum(['clinic', 'patient']).default('clinic'),
        }),
        'reschedule',
      );
      const clinicId = request.tenant.clinicId;
      const ctx = bookingContextFor(app.database, clinicId);
      const tenant = tenantOf(request);
      const now = new Date().toISOString();

      const { appointment, oldStartsAt } = rescheduleAppointment(app.database, tenant, clinicId, ctx, id, {
        startsAt: body.startsAt,
        reason: body.reason,
        actorId: userIdOf(request),
      });
      if (appointment.patientId) syncPatientActivity(tenant, appointment.patientId);

      const enqueued = enqueueAppointmentNotice(app.database, tenant, clinicId, appointment, {
        kind: 'rescheduled',
        oldStartsAt,
        reason: body.reason,
        initiatedBy: body.initiatedBy,
        now,
      });
      return { appointment, whatsappQueued: enqueued };
    }),
  );

  /** The calendar view: slots plus the appointments already on them. */
  app.get(
    '/appointments/calendar',
    { preHandler: requireCapability('appointments:read') },
    handler(async (request) => {
      const query = parseQuery(
        request,
        z.object({
          from: dateKey,
          to: dateKey,
          doctorId: idSchema.optional(),
        }),
      );
      const clinicId = request.tenant.clinicId;
      const tenant = tenantOf(request);
      const ctx = bookingContextFor(app.database, clinicId);

      const span = diffDaysBetweenDateKeys(query.from, query.to);
      if (span < 0) throw ApiError.badRequest('`to` must not be before `from`.');
      if (span > 62) throw ApiError.badRequest('Calendar range is limited to 62 days.');

      const duration = ctx.schedule.slotDurationMinutes;
      const now = new Date().toISOString();
      const slots = availableSlots(tenant, ctx, {
        fromDateKey: query.from,
        toDateKey: query.to,
        durationMinutes: duration,
        doctorId: query.doctorId ?? null,
        now,
      });

      const appointments = tenant
        .page<Row>('appointments', {
          // Local midnights converted to UTC, so a clinic at UTC+3 sees the
          // whole local day rather than losing its first three hours.
          where: 'starts_at >= ? AND starts_at < ?',
          params: [
            zonedTimeToUtc(query.from, '00:00', ctx.timeZone).toISOString(),
            zonedTimeToUtc(addDaysToDateKey(query.to, 1), '00:00', ctx.timeZone).toISOString(),
          ],
          orderBy: 'starts_at ASC',
          limit: 500,
          offset: 0,
        })
        .map(toAppointment)
        .filter((a) => !query.doctorId || a.doctorId === query.doctorId)
        .map((a) => ({ ...a, dateKey: localDateKey(a.startsAt, ctx.timeZone) }));

      const days = dateKeyRange(query.from, query.to).map((key) => {
        const daySlots = slots.filter((s) => s.dateKey === key);
        return {
          dateKey: key,
          slots: daySlots,
          // Empty-day copy only matters when there is nothing to show, so it is
          // computed lazily rather than for all 62 days.
          note: daySlots.length === 0 ? explainDay(tenant, ctx, key, duration, now) : null,
        };
      });

      return {
        from: query.from,
        to: query.to,
        timeZone: ctx.timeZone,
        durationMinutes: duration,
        // Grouped by clinic-local date so the UI can render a day column without
        // re-deriving the timezone on the client.
        appointments,
        days,
      };
    }),
  );

  app.post(
    '/appointments/:id/checked-in',
    { preHandler: requireCapability('appointments:write') },
    handler(async (request) => {
      const { id } = parseParams(request, z.object({ id: idSchema }));
      const tenant = tenantOf(request);
      const now = new Date().toISOString();
      tenant.update('appointments', id, { status: 'checked_in', checked_in_at: now, updated_at: now });
      return toAppointment(tenant.require<Row>('appointments', id));
    }),
  );

  app.post(
    '/appointments/:id/complete',
    { preHandler: requireCapability('appointments:write') },
    handler(async (request) => {
      const { id } = parseParams(request, z.object({ id: idSchema }));
      const tenant = tenantOf(request);
      const now = new Date().toISOString();
      tenant.update('appointments', id, { status: 'completed', completed_at: now, updated_at: now });
      return toAppointment(tenant.require<Row>('appointments', id));
    }),
  );
}
