/**
 * Reseller console: the administrator sells the app from inside it.
 *
 * Practices join pending and stay dark until accepted; subscriptions track
 * plan and expiry per clinic; every collected subscription payment lands in
 * subscription_payments so billed versus received always reconciles.
 *
 * Everything here requires is_reseller, which is set on the session at
 * login. There is no per-clinic equivalent by design: one clinic's owner
 * must never see another clinic's book.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { createId } from '@mediflow/shared';

import { ApiError, handler, idSchema, moneyMinorSchema, parseBody, parseParams } from '../http/errors.js';
import { truncateAll } from '../db/index.js';

async function requireReseller(request: FastifyRequest): Promise<void> {
  const me = request.tenant.user;
  if (!me) throw ApiError.unauthorized();
  const row = request.server.database
    .prepare('SELECT is_reseller FROM users WHERE id = ?')
    .get(me.id) as { is_reseller: number } | undefined;
  // Re-read rather than trusting the token: a demoted reseller loses access
  // on the very next request, not at token expiry.
  if (!row || Number(row.is_reseller) !== 1) {
    throw ApiError.forbidden('Reseller access required.');
  }
}

const subscriptionSchema = z.object({
  plan: z.string().trim().min(1).max(60),
  status: z.enum(['trial', 'active', 'expired', 'suspended']).optional(),
  subscribedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  expiresAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
});

function toClinicRow(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: String(row['id']),
    name: String(row['name']),
    kind: String(row['kind'] ?? 'clinic'),
    slug: String(row['slug']),
    phone: row['phone'] ? String(row['phone']) : null,
    email: row['email'] ? String(row['email']) : null,
    plan: String(row['plan'] ?? 'trial'),
    subscriptionStatus: String(row['subscription_status'] ?? 'trial'),
    subscribedAt: row['subscribed_at'] ? String(row['subscribed_at']) : null,
    expiresAt: row['expires_at'] ? String(row['expires_at']) : null,
    isActive: Number(row['is_active']) === 1,
    createdAt: String(row['created_at']),
  };
}

export async function registerResellerRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/reseller/pending',
    { preHandler: requireReseller },
    handler(async (request) => {
      void request;
      const rows = app.database
        .prepare(
          `SELECT u.email, u.full_name, u.role, u.created_at,
                  c.id AS clinic_id, c.name AS clinic, c.kind AS clinic_kind
             FROM users u JOIN clinics c ON c.id = u.clinic_id
            WHERE u.is_active = 0 OR c.is_active = 0
            ORDER BY u.created_at ASC LIMIT 200`,
        )
        .all() as Record<string, unknown>[];
      return {
        items: rows.map((r) => ({
          email: String(r['email']),
          fullName: String(r['full_name']),
          role: String(r['role']),
          clinicId: String(r['clinic_id']),
          clinic: String(r['clinic']),
          clinicKind: String(r['clinic_kind'] ?? 'clinic'),
          createdAt: String(r['created_at']),
        })),
      };
    }),
  );

  app.post(
    '/reseller/approve',
    { preHandler: requireReseller },
    handler(async (request) => {
      const body = parseBody(request, z.object({ clinicId: idSchema }), 'approval');
      const clinic = app.database.prepare('SELECT id, name FROM clinics WHERE id = ?').get(body.clinicId) as
        | { id: string; name: string }
        | undefined;
      if (!clinic) throw ApiError.notFound('Clinic not found.');
      const now = new Date().toISOString();
      const apply = app.database.transaction(() => {
        app.database.prepare('UPDATE clinics SET is_active = 1, subscribed_at = ?, updated_at = ? WHERE id = ?').run(
          now.slice(0, 10),
          now,
          body.clinicId,
        );
        app.database.prepare('UPDATE users SET is_active = 1, updated_at = ? WHERE clinic_id = ?').run(now, body.clinicId);
      });
      apply();
      return { ok: true, clinicId: body.clinicId, name: clinic.name };
    }),
  );

  app.post(
    '/reseller/suspend',
    { preHandler: requireReseller },
    handler(async (request) => {
      const body = parseBody(request, z.object({ clinicId: idSchema }), 'suspension');
      const clinic = app.database.prepare('SELECT id FROM clinics WHERE id = ?').get(body.clinicId) as
        | { id: string }
        | undefined;
      if (!clinic) throw ApiError.notFound('Clinic not found.');
      app.database
        .prepare("UPDATE clinics SET is_active = 0, subscription_status = 'suspended', updated_at = ? WHERE id = ?")
        .run(new Date().toISOString(), body.clinicId);
      return { ok: true, clinicId: body.clinicId };
    }),
  );

  app.get(
    '/reseller/clinics',
    { preHandler: requireReseller },
    handler(async (request) => {
      void request;
      const clinics = app.database
        .prepare(
          `SELECT c.*,
              (SELECT email FROM users WHERE clinic_id = c.id ORDER BY created_at ASC LIMIT 1) AS owner_email,
              (SELECT COUNT(*) FROM patients WHERE clinic_id = c.id) AS patients,
              (SELECT COUNT(*) FROM users WHERE clinic_id = c.id AND is_active = 1) AS staff,
              (SELECT COALESCE(SUM(amount_minor), 0) FROM subscription_payments WHERE clinic_id = c.id) AS collected_minor
             FROM clinics c ORDER BY c.created_at DESC LIMIT 200`,
        )
        .all() as Record<string, unknown>[];
      return {
        items: clinics.map((c) => ({
          ...toClinicRow(c),
          ownerEmail: c['owner_email'] ? String(c['owner_email']) : null,
          patientCount: Number(c['patients'] ?? 0),
          staffCount: Number(c['staff'] ?? 0),
          collectedMinor: Number(c['collected_minor'] ?? 0),
        })),
      };
    }),
  );

  app.post(
    '/reseller/subscription',
    { preHandler: requireReseller },
    handler(async (request) => {
      const body = parseBody(
        request,
        z.object({ clinicId: idSchema }).merge(subscriptionSchema),
        'subscription',
      );
      const clinic = app.database.prepare('SELECT id FROM clinics WHERE id = ?').get(body.clinicId) as
        | { id: string }
        | undefined;
      if (!clinic) throw ApiError.notFound('Clinic not found.');
      const values: Record<string, string | null> = { updated_at: new Date().toISOString() };
      values['plan'] = body.plan;
      if (body.status !== undefined) values['subscription_status'] = body.status;
      if (body.subscribedAt !== undefined) values['subscribed_at'] = body.subscribedAt;
      if (body.expiresAt !== undefined) values['expires_at'] = body.expiresAt;
      app.database
        .prepare(
          `UPDATE clinics SET ${Object.keys(values)
            .map((c) => `"${c}" = ?`)
            .join(', ')} WHERE id = ?`,
        )
        .run(...Object.values(values), body.clinicId);
      return { ok: true, clinicId: body.clinicId };
    }),
  );

  app.get(
    '/reseller/clinics/:id/statement',
    { preHandler: requireReseller },
    handler(async (request) => {
      const { id } = parseParams(request, z.object({ id: idSchema }));
      const clinic = app.database.prepare('SELECT * FROM clinics WHERE id = ?').get(id) as
        | Record<string, unknown>
        | undefined;
      if (!clinic) throw ApiError.notFound('Clinic not found.');
      const receipts = app.database
        .prepare(
          `SELECT id, amount_minor, period_start, period_end, reference, note, received_at
             FROM subscription_payments WHERE clinic_id = ? ORDER BY received_at DESC LIMIT 100`,
        )
        .all(id) as Record<string, unknown>[];
      const collected = receipts.reduce((sum, r) => sum + Number(r['amount_minor'] ?? 0), 0);
      const owner = app.database
        .prepare('SELECT email, full_name FROM users WHERE clinic_id = ? ORDER BY created_at ASC LIMIT 1')
        .get(id) as { email: string; full_name: string } | undefined;
      return {
        clinic: { ...toClinicRow(clinic), ownerEmail: owner?.email ?? null, ownerName: owner?.full_name ?? null },
        collectedMinor: collected,
        receipts: receipts.map((r) => ({
          id: String(r['id']),
          amountMinor: Number(r['amount_minor']),
          periodStart: r['period_start'] ? String(r['period_start']) : null,
          periodEnd: r['period_end'] ? String(r['period_end']) : null,
          reference: r['reference'] ? String(r['reference']) : null,
          note: r['note'] ? String(r['note']) : null,
          receivedAt: String(r['received_at']),
        })),
      };
    }),
  );

  app.post(
    '/reseller/collections',
    { preHandler: requireReseller },
    handler(async (request, reply) => {
      const body = parseBody(
        request,
        z.object({
          clinicId: idSchema,
          amountMinor: moneyMinorSchema.refine((v) => v > 0, 'Amount must be greater than zero.'),
          periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
          periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
          reference: z.string().trim().max(120).nullable().optional(),
          note: z.string().trim().max(500).nullable().optional(),
          receivedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
        }),
        'collection',
      );
      const clinic = app.database.prepare('SELECT id FROM clinics WHERE id = ?').get(body.clinicId) as
        | { id: string }
        | undefined;
      if (!clinic) throw ApiError.notFound('Clinic not found.');
      const now = new Date().toISOString();
      const id = createId('sub');
      app.database
        .prepare(
          `INSERT INTO subscription_payments
            (id, clinic_id, amount_minor, period_start, period_end, reference, note,
             received_by, received_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          body.clinicId,
          body.amountMinor,
          body.periodStart ?? null,
          body.periodEnd ?? null,
          body.reference?.trim() ? body.reference.trim() : null,
          body.note?.trim() ? body.note.trim() : null,
          request.tenant.user?.id ?? null,
          body.receivedAt ? `${body.receivedAt}T00:00:00.000Z` : now,
          now,
        );
      return reply.status(201).send({ id });
    }),
  );
}
