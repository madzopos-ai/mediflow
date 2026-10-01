/**
 * Dashboard and notifications.
 *
 * Every count here is a `COUNT(*)` on an indexed tenant column, which is the
 * right tool for a clinic-sized dataset. The alternative - loading rows and
 * counting in JavaScript - would be the first thing to fall over as a practice
 * grows.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { addDaysToDateKey, todayInTz, dateKeyInTz, zonedTimeToUtc } from '@mediflow/shared';

import { handler, idSchema, parseParams } from '../http/errors.js';
import { requireCapability } from '../auth/plugin.js';
import { clinicTimezone, readSettings } from '../services/settings.js';
import { tenantOf } from '../services/context.js';
import type { Row } from '../db/mappers.js';

export async function registerDashboardRoutes(app: FastifyInstance): Promise<void> {
  /** The doctor's daily command centre: today, alerts, unread, due follow-ups. */
  app.get(
    '/dashboard/today',
    { preHandler: requireCapability('appointments:read') },
    handler(async (request) => {
      const clinicId = request.tenant.clinicId;
      const tenant = tenantOf(request);
      const timeZone = clinicTimezone(app.database, clinicId);
      const now = new Date();
      const today = todayInTz(timeZone, now);
      // Local midnights in UTC, not UTC midnights: a clinic at UTC+3 would
      // otherwise lose the first three hours of its own day.
      const dayStart = zonedTimeToUtc(today, '00:00', timeZone).toISOString();
      const dayEnd = zonedTimeToUtc(addDaysToDateKey(today, 1), '00:00', timeZone).toISOString();

      const appointments = tenant.page<Row>('appointments', {
        where: 'starts_at >= ? AND starts_at < ? AND status NOT IN (?, ?)',
        params: [dayStart, dayEnd, 'cancelled', 'no_show'],
        orderBy: 'starts_at ASC',
        limit: 200,
        offset: 0,
      });

      const byStatus: Record<string, number> = {};
      for (const row of appointments) {
        const status = String(row['status']);
        byStatus[status] = (byStatus[status] ?? 0) + 1;
      }

      const alerts = tenant.page<Row>('clinical_alerts', {
        where: "status = 'open'",
        orderBy:
          "CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, created_at DESC",
        limit: 10,
        offset: 0,
      });

      return {
        dateKey: today,
        timeZone,
        appointments: {
          total: appointments.length,
          byStatus,
          next: appointments
            .filter((a) => Date.parse(String(a['starts_at'])) >= now.getTime())
            .slice(0, 5)
            .map(summariseAppointment),
        },
        alerts: {
          open: tenant.count('clinical_alerts', "status = 'open'"),
          critical: tenant.count('clinical_alerts', "status = 'open' AND severity = 'critical'"),
          items: alerts.map((a) => ({
            id: String(a['id']),
            kind: String(a['kind']),
            severity: String(a['severity']),
            title: String(a['title']),
            body: String(a['body']),
            patientId: a['patient_id'] ? String(a['patient_id']) : null,
            createdAt: String(a['created_at']),
          })),
        },
        messages: {
          unreadThreads: tenant.count('message_threads', 'unread_count > 0'),
        },
        followUps: {
          due: tenant.count('follow_ups', "status = 'active' AND next_due_at <= ?", [now.toISOString()]),
          active: tenant.count('follow_ups', "status = 'active'"),
        },
        patients: {
          total: tenant.count('patients', 'is_active = 1'),
          newThisWeek: tenant.count(
            'patients',
            'is_active = 1 AND created_at >= ?',
            [new Date(Date.parse(dayStart) - 6 * 86_400_000).toISOString()],
          ),
        },
        waitlist: {
          waiting: tenant.count('waitlist', "status = 'waiting'"),
          offered: tenant.count('waitlist', "status = 'offered'"),
        },
        outbox: {
          pending: tenant.count('outbox', "status IN ('pending', 'processing')"),
          failed: tenant.count('outbox', "status = 'failed'"),
          dead: tenant.count('outbox', "status = 'dead'"),
        },
        deposits: {
          held: tenant.count('appointments', "status = 'scheduled' AND is_public_booking = 1"),
          outstandingMinor: tenant.withTenant<{ total: number | null }>(
            `SELECT COALESCE(SUM(deposit_required_minor - deposit_paid_minor), 0) AS total
               FROM appointments
              WHERE clinic_id = ? AND status NOT IN ('cancelled', 'no_show')`,
            [tenant.clinicId],
          )[0]?.total ?? 0,
        },
      };
    }),
  );

  /** 30-day trend series for the dashboard charts. */
  app.get(
    '/dashboard/trends',
    { preHandler: requireCapability('analytics:read') },
    handler(async (request) => {
      const tenant = tenantOf(request);
      const timeZone = clinicTimezone(app.database, request.tenant.clinicId);
      const today = todayInTz(timeZone);
      const from = addDaysToDateKey(today, -29);

      const appointmentRows = tenant.withTenant<{ day: string | null; count: number }>(
        `SELECT substr(starts_at, 1, 10) AS day, COUNT(*) AS count
           FROM appointments
          WHERE clinic_id = ? AND starts_at >= ? AND status != 'cancelled'
          GROUP BY day ORDER BY day`,
        [tenant.clinicId, `${from}T00:00:00.000Z`],
      );

      const revenueRows = tenant.withTenant<{ day: string | null; total: number | null }>(
        `SELECT substr(performed_at, 1, 10) AS day, COALESCE(SUM(amount_minor), 0) AS total
           FROM payments
          WHERE clinic_id = ? AND performed_at >= ? AND direction = 'payment' AND status = 'paid'
          GROUP BY day ORDER BY day`,
        [tenant.clinicId, `${from}T00:00:00.000Z`],
      );

      const appointments = new Map(appointmentRows.map((r) => [String(r.day), r.count]));
      const revenue = new Map(revenueRows.map((r) => [String(r.day), Number(r.total ?? 0)]));

      return {
        from,
        to: today,
        timeZone,
        currency: readSettings(app.database, request.tenant.clinicId).finance.currency,
        // A dense series so the chart shows real gaps instead of skipping days.
        points: Array.from({ length: 30 }, (_, i) => {
          const day = addDaysToDateKey(from, i);
          return {
            dateKey: day,
            appointments: appointments.get(day) ?? 0,
            revenueMinor: revenue.get(day) ?? 0,
          };
        }),
      };
    }),
  );

  app.get(
    '/notifications',
    { preHandler: requireCapability('appointments:read') },
    handler(async (request) => {
      const tenant = tenantOf(request);
      const me = request.tenant.user;
      if (!me) return { items: [] };
      return {
        items: tenant.page<Row>('notifications', {
          where: 'user_id = ?',
          params: [me.id],
          orderBy: 'created_at DESC',
          limit: 100,
          offset: 0,
        }),
        unread: tenant.count('notifications', 'user_id = ? AND read_at IS NULL', [me.id]),
      };
    }),
  );

  app.post(
    '/notifications/:id/read',
    { preHandler: requireCapability('appointments:read') },
    handler(async (request) => {
      const { id } = parseParams(request, z.object({ id: idSchema }));
      const tenant = tenantOf(request);
      const me = request.tenant.user;
      if (!me) return { ok: false };

      // Ownership is checked explicitly: the tenant handle scopes by clinic, but
      // a notification is private to one user within that clinic.
      const existing = tenant.get<Row>('notifications', id);
      if (!existing || String(existing['user_id']) !== me.id) {
        return { ok: false, notFound: true };
      }
      const now = new Date().toISOString();
      tenant.update('notifications', id, { read_at: now, updated_at: now });
      return { ok: true };
    }),
  );

  app.post(
    '/notifications/read-all',
    { preHandler: requireCapability('appointments:read') },
    handler(async (request) => {
      const tenant = tenantOf(request);
      const me = request.tenant.user;
      if (!me) return { ok: false, updated: 0 };
      const now = new Date().toISOString();
      const pending = tenant.all<Row>('notifications', 'user_id = ? AND read_at IS NULL', [me.id]);
      for (const notification of pending) {
        tenant.update('notifications', String(notification['id']), { read_at: now, updated_at: now });
      }
      return { ok: true, updated: pending.length };
    }),
  );
}

function summariseAppointment(row: Row): Record<string, unknown> {
  return {
    id: String(row['id']),
    startsAt: String(row['starts_at']),
    endsAt: String(row['ends_at']),
    status: String(row['status']),
    patientName: String(row['patient_name']),
    patientId: row['patient_id'] ? String(row['patient_id']) : null,
    doctorName: row['doctor_name'] ? String(row['doctor_name']) : null,
    reason: row['reason'] ? String(row['reason']) : null,
    visitType: String(row['visit_type']),
    dateKey: dateKeyInTz(new Date(String(row['starts_at'])), 'UTC'),
  };
}
