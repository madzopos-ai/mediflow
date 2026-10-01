/**
 * Clinic profile, schedule, and settings.
 *
 * Settings and schedule are stored as JSON documents keyed by clinic id. That
 * keeps the schema stable while the policy shape evolves, at the cost of not
 * being queryable in SQL - which is fine, because nothing queries them.
 *
 * Every read merges the stored value over the current defaults, so a clinic
 * created before a settings field existed still receives it.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ClinicSchedule, ClinicSettings } from '@mediflow/shared';

import { ApiError, handler, parseBody } from '../http/errors.js';
import { requireCapability } from '../auth/plugin.js';
import { defaultWorkingHours } from '../db/defaults.js';
import { readSchedule, readSettings } from '../services/settings.js';
import { jsonColumn, type Row } from '../db/mappers.js';

const scheduleSchema = z.object({
  workingHours: z
    .array(
      z.object({
        weekday: z.number().int().min(0).max(6),
        enabled: z.boolean(),
        start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
        end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
        breaks: z
          .array(
            z.object({
              start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
              end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
              label: z.string().max(80),
            }),
          )
          .max(6),
      }),
    )
    .length(7),
  slotDurationMinutes: z.number().int().min(5).max(480),
  bufferMinutes: z.number().int().min(0).max(120),
  slotIntervalMinutes: z.number().int().min(5).max(480),
  maxDailyAppointments: z.number().int().min(1).max(500).nullable(),
  holidays: z.array(z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), label: z.string().max(120) })).max(400),
  blockedWindows: z
    .array(
      z.object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
        end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
        label: z.string().max(120),
      }),
    )
    .max(400),
  allowWalkIn: z.boolean(),
});

const profileSchema = z.object({
  name: z.string().trim().min(2).max(160).optional(),
  nameAr: z.string().trim().max(160).nullable().optional(),
  timezone: z.string().trim().min(3).max(64).optional(),
  country: z.string().trim().max(64).nullable().optional(),
  currency: z.string().trim().length(3).optional(),
  phone: z.string().trim().max(24).nullable().optional(),
  email: z.string().trim().email().max(254).nullable().optional(),
  address: z.string().trim().max(400).nullable().optional(),
  logoUrl: z.string().trim().max(500).nullable().optional(),
});

const settingsSchema = z
  .object({
    features: z.record(z.string(), z.unknown()).optional(),
    reminders: z.record(z.string(), z.unknown()).optional(),
    followUps: z.record(z.string(), z.unknown()).optional(),
    booking: z.record(z.string(), z.unknown()).optional(),
    whatsapp: z.record(z.string(), z.unknown()).optional(),
    ai: z.record(z.string(), z.unknown()).optional(),
    finance: z.record(z.string(), z.unknown()).optional(),
    notifications: z.record(z.string(), z.unknown()).optional(),
  })
  .partial();

export { readSchedule, readSettings, clinicTimezone } from '../services/settings.js';

export async function registerClinicRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/clinic',
    { preHandler: requireCapability('settings:read') },
    handler(async (request) => {
      const clinicId = request.tenant.clinicId;
      const row = app.database.prepare('SELECT * FROM clinics WHERE id = ?').get(clinicId) as Row | undefined;
      if (!row) throw ApiError.notFound('Clinic not found.');
      return {
        id: String(row['id']),
        name: String(row['name']),
        nameAr: row['name_ar'] ? String(row['name_ar']) : null,
        slug: String(row['slug']),
        timezone: String(row['timezone']),
        country: row['country'] ? String(row['country']) : null,
        currency: String(row['currency']),
        phone: row['phone'] ? String(row['phone']) : null,
        email: row['email'] ? String(row['email']) : null,
        address: row['address'] ? String(row['address']) : null,
        logoUrl: row['logo_url'] ? String(row['logo_url']) : null,
      };
    }),
  );

  app.patch(
    '/clinic',
    { preHandler: requireCapability('settings:write') },
    handler(async (request) => {
      const body = parseBody(request, profileSchema, 'clinic profile');
      const clinicId = request.tenant.clinicId;
      const now = new Date().toISOString();

      // A bad IANA zone would make every slot in the system wrong, so it is
      // validated by actually formatting a date with it.
      if (body.timezone !== undefined) {
        try {
          new Intl.DateTimeFormat('en-US', { timeZone: body.timezone }).format(new Date());
        } catch {
          throw ApiError.badRequest('Not a valid IANA timezone.', [
            { path: 'timezone', message: `Unknown timezone "${body.timezone}".` },
          ]);
        }
      }

      const values: Record<string, string | null> = { updated_at: now };
      if (body.name !== undefined) values['name'] = body.name;
      if (body.nameAr !== undefined) values['name_ar'] = body.nameAr;
      if (body.timezone !== undefined) values['timezone'] = body.timezone;
      if (body.country !== undefined) values['country'] = body.country;
      if (body.currency !== undefined) values['currency'] = body.currency!.toUpperCase();
      if (body.phone !== undefined) values['phone'] = body.phone;
      if (body.email !== undefined) values['email'] = body.email;
      if (body.address !== undefined) values['address'] = body.address;
      if (body.logoUrl !== undefined) values['logo_url'] = body.logoUrl;

      app.database
        .prepare(
          `UPDATE clinics SET ${Object.keys(values)
            .map((k) => `"${k}" = ?`)
            .join(', ')} WHERE id = ?`,
        )
        .run(...Object.values(values), clinicId);

      return { ok: true };
    }),
  );

  app.get(
    '/clinic/settings',
    { preHandler: requireCapability('settings:read') },
    handler(async (request) => readSettings(app.database, request.tenant.clinicId)),
  );

  app.put(
    '/clinic/settings',
    { preHandler: requireCapability('settings:write') },
    handler(async (request) => {
      const clinicId = request.tenant.clinicId;
      const patch = parseBody(request, settingsSchema, 'settings');
      const current = readSettings(app.database, clinicId);
      const merged: ClinicSettings = {
        ...current,
        ...(patch.features ? { features: { ...current.features, ...patch.features } } : {}),
        ...(patch.reminders ? { reminders: { ...current.reminders, ...patch.reminders } } : {}),
        ...(patch.followUps ? { followUps: { ...current.followUps, ...patch.followUps } } : {}),
        ...(patch.booking ? { booking: { ...current.booking, ...patch.booking } } : {}),
        ...(patch.whatsapp ? { whatsapp: { ...current.whatsapp, ...patch.whatsapp } } : {}),
        ...(patch.ai ? { ai: { ...current.ai, ...patch.ai } } : {}),
        ...(patch.finance ? { finance: { ...current.finance, ...patch.finance } } : {}),
        ...(patch.notifications ? { notifications: { ...current.notifications, ...patch.notifications } } : {}),
      };
      const now = new Date().toISOString();
      app.database
        .prepare(
          `INSERT INTO clinic_settings (clinic_id, json, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(clinic_id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`,
        )
        .run(clinicId, jsonColumn(merged), now);
      return merged;
    }),
  );

  app.get(
    '/clinic/schedule',
    { preHandler: requireCapability('appointments:read') },
    handler(async (request) => readSchedule(app.database, request.tenant.clinicId)),
  );

  app.put(
    '/clinic/schedule',
    { preHandler: requireCapability('settings:write') },
    handler(async (request) => {
      const clinicId = request.tenant.clinicId;
      const body = parseBody(request, scheduleSchema, 'schedule');
      const current = readSchedule(app.database, clinicId);
      const next: ClinicSchedule = {
        ...current,
        ...body,
        id: current.id,
        clinicId,
        updatedAt: new Date().toISOString(),
      };

      // A slot interval shorter than the visit duration would generate
      // overlapping slots, so reject it here rather than at booking time.
      if (next.slotIntervalMinutes < next.slotDurationMinutes) {
        throw ApiError.badRequest('Slot interval must be at least the slot duration.', [
          { path: 'slotIntervalMinutes', message: 'Interval cannot be shorter than the duration.' },
        ]);
      }
      for (const day of next.workingHours) {
        if (day.enabled && day.start >= day.end) {
          throw ApiError.badRequest('A working day must end after it starts.', [
            { path: `workingHours.${day.weekday}`, message: 'End time must be after start time.' },
          ]);
        }
      }

      const now = new Date().toISOString();
      app.database
        .prepare(
          `INSERT INTO clinic_schedules (id, clinic_id, json, updated_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`,
        )
        .run(next.id, clinicId, jsonColumn(next), now);
      return next;
    }),
  );

  app.get(
    '/clinic/working-hours-template',
    { preHandler: requireCapability('settings:read') },
    handler(async () => ({ workingHours: defaultWorkingHours() })),
  );
}
