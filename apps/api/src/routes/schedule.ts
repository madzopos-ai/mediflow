/**
 * Availability and schedule queries.
 *
 * Separate from `/appointments` because availability is a read that the public
 * booking page and the calendar both need, and it exposes no patient data.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { addDaysToDateKey, dateKeyRange, diffDaysBetweenDateKeys, todayInTz } from '@mediflow/shared';

import { ApiError, handler, idSchema, parseQuery } from '../http/errors.js';
import { requireCapability } from '../auth/plugin.js';
import { clinicTimezone, readSchedule, readSettings } from './clinic.js';
import { tenantOf } from '../services/context.js';
import { availableSlots, explainDay } from '../services/appointments.js';
import { bookingContextFor } from '../services/appointments.js';

const dateKey = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be yyyy-mm-dd.');

export async function registerScheduleRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/schedule/availability',
    { preHandler: requireCapability('appointments:read') },
    handler(async (request) => {
      const query = parseQuery(
        request,
        z.object({
          from: dateKey.optional(),
          to: dateKey.optional(),
          days: z.coerce.number().int().min(1).max(62).default(14),
          doctorId: idSchema.nullable().optional(),
          durationMinutes: z.coerce.number().int().min(5).max(480).optional(),
        }),
      );
      const clinicId = request.tenant.clinicId;
      const ctx = bookingContextFor(app.database, clinicId);
      const tenant = tenantOf(request);
      const now = new Date().toISOString();

      const today = todayInTz(ctx.timeZone, new Date(now));
      const from = query.from ?? today;
      const to = query.to ?? addDaysToDateKey(from, query.days - 1);

      const span = diffDaysBetweenDateKeys(from, to);
      if (span < 0) throw ApiError.badRequest('`to` must not be before `from`.');
      if (span > 61) throw ApiError.badRequest('Availability range is limited to 62 days.');

      const duration = query.durationMinutes ?? ctx.schedule.slotDurationMinutes;
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
        timeZone: ctx.timeZone,
        durationMinutes: duration,
        total: slots.length,
        days: dateKeyRange(from, to).map((key) => {
          const daySlots = slots.filter((s) => s.dateKey === key);
          return {
            dateKey: key,
            count: daySlots.length,
            slots: daySlots,
            // Only sent when empty, to save payload on a busy calendar.
            note: daySlots.length === 0 ? explainDay(tenant, ctx, key, duration, now) : null,
          };
        }),
      };
    }),
  );

  app.get(
    '/schedule/next-available',
    { preHandler: requireCapability('appointments:read') },
    handler(async (request) => {
      const query = parseQuery(
        request,
        z.object({
          withinDays: z.coerce.number().int().min(1).max(90).default(30),
          doctorId: idSchema.nullable().optional(),
          durationMinutes: z.coerce.number().int().min(5).max(480).optional(),
        }),
      );
      const clinicId = request.tenant.clinicId;
      const ctx = bookingContextFor(app.database, clinicId);
      const tenant = tenantOf(request);
      const now = new Date().toISOString();

      const from = todayInTz(ctx.timeZone, new Date(now));
      const to = addDaysToDateKey(from, query.withinDays - 1);
      const duration = query.durationMinutes ?? ctx.schedule.slotDurationMinutes;

      const slots = availableSlots(tenant, ctx, {
        fromDateKey: from,
        toDateKey: to,
        durationMinutes: duration,
        doctorId: query.doctorId ?? null,
        now,
      });

      return { next: slots[0] ?? null, searchedDays: query.withinDays };
    }),
  );

  app.get(
    '/schedule/working-hours',
    { preHandler: requireCapability('appointments:read') },
    handler(async (request) => {
      const schedule = readSchedule(app.database, request.tenant.clinicId);
      const settings = readSettings(app.database, request.tenant.clinicId);
      return {
        timeZone: clinicTimezone(app.database, request.tenant.clinicId),
        workingHours: schedule.workingHours,
        slotDurationMinutes: schedule.slotDurationMinutes,
        bufferMinutes: schedule.bufferMinutes,
        maxDailyAppointments: schedule.maxDailyAppointments,
        allowWalkIn: schedule.allowWalkIn,
        holidays: schedule.holidays,
        blockedWindows: schedule.blockedWindows,
        minNoticeHours: settings.booking.minNoticeHours,
        maxAdvanceDays: settings.booking.maxAdvanceDays,
      };
    }),
  );
}
