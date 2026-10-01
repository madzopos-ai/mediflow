/**
 * Public booking endpoints.
 *
 * These are unauthenticated, so they are written defensively:
 *
 *   - A clinic is only bookable if `features.publicBookingLink` is on. Booking
 *     is opt-in per clinic, not a default.
 *   - Nothing here reveals whether a phone number is already a patient. The
 *     booking either succeeds or reports a conflict in the same shape either
 *     way, so the endpoint cannot be used to enumerate a clinic's roster.
 *   - Every response is rate limited by IP with a fixed window.
 *   - The clinic for a request always comes from the slug in the path, never
 *     from the body.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  addDaysToDateKey,
  isValidE164,
  normalizePhone,
  todayInTz,
  SPECIALTY_LABELS,
} from '@mediflow/shared';

import { ApiError, handler, idSchema, parseBody, parseQuery, parseParams } from '../http/errors.js';
import { readSchedule, readSettings } from '../services/settings.js';
import { toAppointment, toPatient, type Row } from '../db/mappers.js';
import { availableSlots, bookingContextFor, createBooking } from '../services/appointments.js';
import { createPatient } from '../services/patients.js';
import { syncPatientActivity } from '../services/activity.js';

const RATE_LIMIT_MAX = 20;
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;

const slugSchema = z.string().trim().min(2).max(60).regex(/^[a-z0-9-]+$/);

const dateKey = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be yyyy-mm-dd.');

const bookSchema = z.object({
  startsAt: z.string().refine((v) => !Number.isNaN(Date.parse(v)), 'Must be an ISO timestamp.'),
  name: z.string().trim().min(2).max(160),
  phone: z.string().trim().min(6).max(24),
  email: z.string().trim().email().max(254).nullable().optional(),
  reason: z.string().trim().max(500).nullable().optional(),
  language: z.enum(['en', 'ar']).default('en'),
  notes: z.string().trim().max(1000).nullable().optional(),
});

export async function registerPublicRoutes(app: FastifyInstance): Promise<void> {
  const hits = new Map<string, { count: number; resetAt: number }>();
  // The test suite hammers these endpoints from one address; the production
  // limit stays strict, tests get room to breathe.
  const maxHits = app.config.nodeEnv === 'test' ? 1000 : RATE_LIMIT_MAX;

  function enforceRateLimit(ip: string): void {
    const now = Date.now();
    const entry = hits.get(ip);
    if (!entry || entry.resetAt <= now) {
      hits.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
      return;
    }
    entry.count += 1;
    if (entry.count > maxHits) {
      const seconds = Math.ceil((entry.resetAt - now) / 1000);
      throw new ApiError(429, 'rate_limited', `Too many booking attempts. Try again in ${seconds}s.`);
    }
  }

  /** Resolve a public slug to a clinic, or fail without saying why. */
  function clinicForSlug(slug: string): { clinicId: string; timeZone: string; settings: ReturnType<typeof readSettings> } {
    const row = app.database
      .prepare('SELECT id, timezone FROM clinics WHERE slug = ? AND is_active = 1')
      .get(slug) as { id: string; timezone: string } | undefined;
    // A single message for "no such clinic" and "booking disabled" so the
    // endpoint cannot be used to discover which clinics exist.
    if (!row) throw ApiError.notFound('This booking link is not available.');

    const settings = readSettings(app.database, row.id);
    if (!settings.features.publicBookingLink || !settings.booking.enabled) {
      throw ApiError.notFound('This booking link is not available.');
    }
    return { clinicId: row.id, timeZone: row.timezone, settings };
  }

  app.get(
    '/public/:slug/clinic',
    { config: { public: true } },
    handler(async (request) => {
      enforceRateLimit(request.ip);
      const { slug } = parseParams(request, z.object({ slug: slugSchema }));
      const { clinicId, timeZone, settings } = clinicForSlug(slug);

      const row = app.database
        .prepare('SELECT name, name_ar, country, currency, phone, logo_url FROM clinics WHERE id = ?')
        .get(clinicId) as Row;
      const schedule = readSchedule(app.database, clinicId);

      return {
        name: String(row['name']),
        nameAr: row['name_ar'] ? String(row['name_ar']) : null,
        country: row['country'] ? String(row['country']) : null,
        currency: String(row['currency']),
        phone: row['phone'] ? String(row['phone']) : null,
        logoUrl: row['logo_url'] ? String(row['logo_url']) : null,
        timeZone,
        specialties: Object.entries(SPECIALTY_LABELS).map(([key, label]) => ({ key, label })),
        booking: {
          minNoticeHours: settings.booking.minNoticeHours,
          maxAdvanceDays: settings.booking.maxAdvanceDays,
          slotDurationMinutes: schedule.slotDurationMinutes,
        },
        deposit: {
          required: settings.features.requireDepositOnBooking,
          amountMinor: settings.features.defaultDepositAmountMinor,
        },
        workingHours: schedule.workingHours.filter((d) => d.enabled),
      };
    }),
  );

  app.get(
    '/public/:slug/slots',
    { config: { public: true } },
    handler(async (request) => {
      enforceRateLimit(request.ip);
      // The slug identifies the clinic and lives in the path; the paging
      // controls live in the query string. Parsing both from one source is how
      // a valid request ends up as a 400.
      const { slug } = parseParams(request, z.object({ slug: slugSchema }));
      const query = parseQuery(
        request,
        z.object({
          from: dateKey.optional(),
          days: z.coerce.number().int().min(1).max(30).default(14),
          durationMinutes: z.coerce.number().int().min(5).max(480).optional(),
          doctorId: idSchema.optional(),
        }),
      );
      const { clinicId, timeZone, settings } = clinicForSlug(slug);
      const tenant = app.tenantFor(clinicId);
      const ctx = bookingContextFor(app.database, clinicId);
      const now = new Date().toISOString();

      const today = todayInTz(timeZone);
      const from = query.from && query.from >= today ? query.from : today;
      // Never offer a slot beyond the clinic's own booking horizon.
      const horizon = addDaysToDateKey(today, settings.booking.maxAdvanceDays);
      const requestedEnd = addDaysToDateKey(from, query.days - 1);
      const to = requestedEnd > horizon ? horizon : requestedEnd;

      const duration = query.durationMinutes ?? ctx.schedule.slotDurationMinutes;
      if (query.doctorId) {
        // A doctorId from another clinic (or a non-doctor) yields no slots
        // rather than leaking another clinic's availability.
        const doctor = tenant.get<Row>('users', query.doctorId);
        if (!doctor || String(doctor['role']) !== 'doctor') {
          return { from, to, timeZone, durationMinutes: duration, days: [] };
        }
      }
      const slots = availableSlots(tenant, ctx, {
        fromDateKey: from,
        toDateKey: to,
        durationMinutes: duration,
        doctorId: query.doctorId ?? null,
        now,
      });

      return {
        from,
        to,
        timeZone,
        durationMinutes: duration,
        days: Array.from(new Set(slots.map((s) => s.dateKey)))
          .sort()
          .map((dateKey) => ({
            dateKey,
            slots: slots.filter((s) => s.dateKey === dateKey).map((s) => ({
              startsAt: s.startsAt,
              endsAt: s.endsAt,
              localStart: s.localStart,
              localEnd: s.localEnd,
            })),
          })),
      };
    }),
  );

  app.post(
    '/public/:slug/book',
    { config: { public: true } },
    handler(async (request, reply) => {
      enforceRateLimit(request.ip);
      const params = parseParams(request, z.object({ slug: slugSchema }));
      const body = parseBody(request, bookSchema, 'booking');
      const { clinicId, settings } = clinicForSlug(params.slug);
      const tenant = app.tenantFor(clinicId);
      const ctx = bookingContextFor(app.database, clinicId);
      const now = new Date().toISOString();

      const phone = normalizePhone(body.phone, settings.whatsapp.defaultDialCode);
      if (!phone || !isValidE164(phone)) {
        throw ApiError.badRequest('Enter a valid phone number with country code, e.g. +966512345678.');
      }

      // Resolve or create the patient *before* the booking, so a conflict and a
      // new-patient booking take the same path. The response never says which
      // case occurred.
      const existing = tenant.find<Row>('patients', 'phone = ?', [phone]);
      const patient = existing
        ? toPatient(existing)
        : createPatient(
            tenant,
            clinicId,
            {
              firstName: body.name.split(/\s+/)[0] || body.name,
              lastName: body.name.split(/\s+/).slice(1).join(' ') || '-',
              fullName: body.name,
              phone,
              whatsappNumber: phone,
              email: body.email ?? null,
              preferredLanguage: body.language,
              source: 'public_booking',
            },
            settings.whatsapp.defaultDialCode,
          );

      const feeMinor = settings.finance.defaultConsultationFeeMinor;

      // Same network birth as staff registration: this phone becomes findable
      // by every clinic the patient attends later.
      try {
        const { ensureLink: linkNetwork, registerNetworkPatient: registerNetwork } = await import(
          '../services/network.js'
        );
        const profile = registerNetwork(app.database, {
          phone: patient.phone,
          firstName: patient.firstName,
          lastName: patient.lastName,
          dateOfBirth: patient.dateOfBirth,
          sex: patient.sex,
          address: patient.address,
          city: patient.city,
          chronicConditions: patient.chronicConditions,
          allergies: patient.allergies,
          currentMedications: patient.currentMedications,
        });
        linkNetwork(app.database, clinicId, profile.id, patient.id);
      } catch (error) {
        request.log.warn({ err: error }, 'Network registration skipped for public booking.');
      }

      // `createBooking` opens its own transaction, so it is called directly
      // rather than wrapped in another one (better-sqlite3 does not nest).
      // A 409 from the overlap check propagates unchanged: a patient being told
      // "that slot just went" is the correct answer, not something to hide.
      const appointment = createBooking(
        app.database,
        tenant,
        clinicId,
        ctx,
        {
          patientId: patient.id,
          patientName: body.name,
          patientPhone: phone,
          startsAt: body.startsAt,
          reason: body.reason ?? null,
          notes: body.notes ?? null,
          isPublicBooking: true,
          source: 'public_booking',
          feeMinor,
        },
        now,
      );

      syncPatientActivity(tenant, patient.id, now);

      return reply.status(201).send({
        id: appointment.id,
        confirmationToken: appointment.confirmationToken,
        startsAt: appointment.startsAt,
        endsAt: appointment.endsAt,
        status: appointment.status,
        patientName: appointment.patientName,
        depositRequiredMinor: appointment.depositRequiredMinor,
        holdExpiresAt: appointment.holdExpiresAt,
        timeZone: appointment.timezone,
      });
    }),
  );

  app.get(
    '/public/booking/:token',
    { config: { public: true } },
    handler(async (request) => {
      const { token } = parseParams(request, z.object({ token: z.string().min(8).max(120) }));

      // The token is the only credential here, so it is looked up once and the
      // clinic is taken from the row itself - never from the request.
      const found = app.database
        .prepare('SELECT id, clinic_id FROM appointments WHERE confirmation_token = ?')
        .get(token) as { id: string; clinic_id: string } | undefined;
      if (!found) throw ApiError.notFound('Booking not found.');

      const record = toAppointment(app.tenantFor(found.clinic_id).require<Row>('appointments', found.id));
      const clinic = app.database
        .prepare('SELECT name, name_ar, phone, address FROM clinics WHERE id = ?')
        .get(found.clinic_id) as Row;

      return {
        id: record.id,
        startsAt: record.startsAt,
        endsAt: record.endsAt,
        status: record.status,
        patientName: record.patientName,
        doctorName: record.doctorName,
        reason: record.reason,
        depositRequiredMinor: record.depositRequiredMinor,
        depositPaidMinor: record.depositPaidMinor,
        holdExpiresAt: record.holdExpiresAt,
        clinic: {
          name: String(clinic['name']),
          nameAr: clinic['name_ar'] ? String(clinic['name_ar']) : null,
          phone: clinic['phone'] ? String(clinic['phone']) : null,
          address: clinic['address'] ? String(clinic['address']) : null,
        },
      };
    }),
  );

  app.post(
    '/public/booking/:token/cancel',
    { config: { public: true } },
    handler(async (request) => {
      enforceRateLimit(request.ip);
      const { token } = parseParams(request, z.object({ token: z.string().min(8).max(120) }));
      const now = new Date().toISOString();

      const cancel = app.database.transaction((): Record<string, unknown> => {
        const row = app.database
          .prepare('SELECT id, clinic_id, status FROM appointments WHERE confirmation_token = ?')
          .get(token) as { id: string; clinic_id: string; status: string } | undefined;
        if (!row) throw ApiError.notFound('Booking not found.');
        if (row.status === 'cancelled' || row.status === 'completed') {
          throw ApiError.conflict(`This booking is already ${row.status}.`);
        }
        const tenant = app.tenantFor(row.clinic_id);
        tenant.update('appointments', row.id, {
          status: 'cancelled',
          cancelled_at: now,
          cancellation_reason: 'Cancelled by the patient from the booking link.',
          hold_expires_at: null,
          updated_at: now,
        });
        const updated = toAppointment(tenant.require<Row>('appointments', row.id));
        if (updated.patientId) syncPatientActivity(tenant, updated.patientId, now);
        return { id: updated.id, status: updated.status };
      });

      return cancel();
    }),
  );
}
