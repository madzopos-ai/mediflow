/**
 * Finance: invoices and the payment ledger.
 *
 * Money is integer minor units everywhere. Balances are never stored as a
 * running total that a partial write could corrupt - `patients.balance_minor`
 * is a cache that is recomputed from the ledger by `syncPatientBalance`, and the
 * ledger is the source of truth.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createId, PAYMENT_METHODS, type PaymentMethod, type PaymentStatus } from '@mediflow/shared';

import {
  ApiError,
  handler,
  idSchema,
  moneyMinorSchema,
  paginationSchema,
  parseBody,
  parseQuery, parseParams } from '../http/errors.js';
import { requireCapability } from '../auth/plugin.js';
import { readSettings } from './clinic.js';
import { tenantOf, userIdOf } from '../services/context.js';
import { nullable, type Row } from '../db/mappers.js';
import { syncPatientBalance } from '../services/activity.js';

const createInvoiceSchema = z.object({
  patientId: idSchema,
  appointmentId: idSchema.nullable().optional(),
  items: z
    .array(
      z.object({
        description: z.string().trim().min(1).max(200),
        quantity: z.number().int().min(1).max(999).default(1),
        unitPriceMinor: moneyMinorSchema,
      }),
    )
    .min(1)
    .max(50),
  discountMinor: moneyMinorSchema.default(0),
  taxPercent: z.number().min(0).max(100).optional(),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
});

const recordPaymentSchema = z.object({
  patientId: idSchema,
  invoiceId: idSchema.nullable().optional(),
  appointmentId: idSchema.nullable().optional(),
  amountMinor: moneyMinorSchema.refine((v) => v > 0, 'Payment must be greater than zero.'),
  method: z.enum(PAYMENT_METHODS),
  reference: z.string().trim().max(120).nullable().optional(),
  isDeposit: z.boolean().default(false),
  note: z.string().trim().max(500).nullable().optional(),
});

/** Derive an invoice status from what has been paid, rather than storing it blindly. */
export function statusFor(totalMinor: number, paidMinor: number): PaymentStatus {
  if (paidMinor <= 0) return totalMinor > 0 ? 'pending' : 'paid';
  if (paidMinor >= totalMinor) return 'paid';
  return 'partial';
}

const insurerSchema = z.object({
  name: z.string().trim().min(2).max(160),
  nameAr: z.string().trim().max(160).nullable().optional(),
  coveragePercent: z.number().min(0).max(100),
  annualLimitMinor: moneyMinorSchema.nullable().optional(),
  perVisitLimitMinor: moneyMinorSchema.nullable().optional(),
  phone: z.string().trim().max(24).nullable().optional(),
  email: z.string().trim().email().max(254).nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
});

export function toInsurer(row: Row): Record<string, unknown> {
  return {
    id: String(row['id']),
    name: String(row['name']),
    nameAr: row['name_ar'] ? String(row['name_ar']) : null,
    coveragePercent: Number(row['coverage_percent']),
    annualLimitMinor: row['annual_limit_minor'] !== null ? Number(row['annual_limit_minor']) : null,
    perVisitLimitMinor: row['per_visit_limit_minor'] !== null ? Number(row['per_visit_limit_minor']) : null,
    phone: row['phone'] ? String(row['phone']) : null,
    email: row['email'] ? String(row['email']) : null,
    notes: row['notes'] ? String(row['notes']) : null,
    isActive: Number(row['is_active']) === 1,
    createdAt: String(row['created_at']),
    updatedAt: String(row['updated_at']),
  };
}

export async function registerFinanceRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/invoices',
    { preHandler: requireCapability('billing:read') },
    handler(async (request) => {
      const query = parseQuery(
        request,
        paginationSchema.extend({
          status: z.enum(['pending', 'partial', 'paid', 'refunded', 'failed', 'waived']).optional(),
          patientId: idSchema.optional(),
          from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
          to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
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
      if (query.from) {
        where.push('created_at >= ?');
        params.push(`${query.from}T00:00:00.000Z`);
      }
      if (query.to) {
        where.push('created_at <= ?');
        params.push(`${query.to}T23:59:59.999Z`);
      }
      const clause = where.length > 0 ? where.join(' AND ') : undefined;
      const rows = tenant.page<Row>('invoices', {
        where: clause,
        params,
        orderBy: 'created_at DESC',
        limit: query.limit,
        offset: query.offset,
      });
      return { items: rows, total: tenant.count('invoices', clause, params) };
    }),
  );

  app.get(
    '/invoices/:id',
    { preHandler: requireCapability('billing:read') },
    handler(async (request) => {
      const { id } = parseParams(request, z.object({ id: idSchema }));
      const tenant = tenantOf(request);
      const invoice = tenant.require<Row>('invoices', id);
      return {
        invoice,
        items: tenant.all<Row>('invoice_items', 'invoice_id = ?', [id]),
        payments: tenant.page<Row>('payments', {
          where: 'invoice_id = ?',
          params: [id],
          orderBy: 'performed_at DESC',
          limit: 200,
          offset: 0,
        }),
      };
    }),
  );

  app.post(
    '/invoices',
    { preHandler: requireCapability('billing:write') },
    handler(async (request, reply) => {
      const body = parseBody(request, createInvoiceSchema, 'invoice');
      const tenant = tenantOf(request);
      const clinicId = request.tenant.clinicId;
      const settings = readSettings(app.database, clinicId);
      tenant.require('patients', body.patientId);
      if (body.appointmentId) tenant.require('appointments', body.appointmentId);

      const now = new Date().toISOString();
      const taxPercent = body.taxPercent ?? settings.finance.taxPercent;

      // All arithmetic in integers, rounded once at each tax step, so the
      // stored total always equals subtotal + tax - discount exactly.
      const lineAmounts = body.items.map((item) => Math.round(item.quantity * item.unitPriceMinor));
      const subtotal = lineAmounts.reduce((sum, v) => sum + v, 0);
      const tax = Math.round((subtotal * taxPercent) / 100);
      const total = Math.max(0, subtotal + tax - body.discountMinor);

      const id = createId('inv');
      const sequence = tenant.count('invoices') + 1;
      const number = `${settings.finance.receiptPrefix}-${new Date().getUTCFullYear()}-${String(sequence).padStart(5, '0')}`;

      // Insurance split, snapshotted: the patient's insurer (if active) covers
      // its percent up to the per-visit and remaining annual caps. The ledger
      // charge is the patient share - the insurer's share is a receivable on
      // the invoice row, not money the patient owes.
      let splitInsurerId: string | null = null;
      let insurerShare = 0;
      const patientRow = tenant.get<Row>('patients', body.patientId);
      const insurerRef = patientRow?.['insurer_id'] ? String(patientRow['insurer_id']) : null;
      if (insurerRef) {
        const insurer = tenant.get<Row>('insurers', insurerRef);
        if (insurer && Number(insurer['is_active']) === 1) {
          const pct = Number(insurer['coverage_percent']);
          if (pct > 0 && total > 0) {
            let share = Math.round((total * pct) / 100);
            const perVisit = insurer['per_visit_limit_minor'];
            if (typeof perVisit === 'number') share = Math.min(share, perVisit);
            const annual = insurer['annual_limit_minor'];
            if (typeof annual === 'number') {
              const yearStart = `${new Date().getUTCFullYear()}-01-01T00:00:00.000Z`;
              const used =
                tenant.withTenant<{ t: number | null }>(
                  `SELECT COALESCE(SUM(insurer_share_minor), 0) AS t FROM invoices
                    WHERE clinic_id = ? AND patient_id = ? AND created_at >= ?`,
                  [clinicId, body.patientId, yearStart],
                )[0]?.t ?? 0;
              share = Math.max(0, Math.min(share, annual - used));
            }
            if (share > 0) {
              splitInsurerId = String(insurer['id']);
              insurerShare = Math.min(share, total);
            }
          }
        }
      }
      const patientShare = total - insurerShare;

      const write = app.database.transaction(() => {
        tenant.insert('invoices', {
          id,
          clinic_id: clinicId,
          patient_id: body.patientId,
          appointment_id: nullable(body.appointmentId),
          number,
          currency: settings.finance.currency,
          subtotal_minor: subtotal,
          discount_minor: body.discountMinor,
          tax_minor: tax,
          total_minor: total,
          paid_minor: 0,
          insurer_id: nullable(splitInsurerId),
          insurer_share_minor: insurerShare,
          patient_share_minor: patientShare,
          status: statusFor(patientShare, 0),
          due_date: nullable(body.dueDate),
          issued_by: userIdOf(request),
          notes: nullable(body.notes),
          paid_at: null,
          reminder_sent_at: null,
          created_at: now,
          updated_at: now,
        });

        const insertItem = app.database.prepare(
          `INSERT INTO invoice_items (id, clinic_id, invoice_id, description, quantity, unit_price_minor, amount_minor, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        body.items.forEach((item, index) => {
          insertItem.run(
            createId('iti'),
            clinicId,
            id,
            item.description,
            item.quantity,
            item.unitPriceMinor,
            lineAmounts[index] ?? 0,
            now,
            now,
          );
        });

        // An invoice is a charge in the ledger, so the patient balance and the
        // invoice list can never disagree. The charge is the patient share -
        // the insurer's part is tracked on the invoice, not owed by them.
        tenant.insert('payments', {
          id: createId('pay'),
          clinic_id: clinicId,
          patient_id: body.patientId,
          invoice_id: id,
          appointment_id: nullable(body.appointmentId),
          type: 'consultation',
          direction: 'charge',
          amount_minor: patientShare,
          currency: settings.finance.currency,
          method: null,
          status: 'pending',
          description: `Invoice ${number}`,
          reference: number,
          performed_by: userIdOf(request),
          performed_at: now,
          is_deposit: 0,
          note: nullable(body.notes),
          created_at: now,
          updated_at: now,
        });
      });
      write();

      syncPatientBalance(tenant, body.patientId, now);
      return reply.status(201).send(tenant.require<Row>('invoices', id));
    }),
  );

  app.post(
    '/payments',
    { preHandler: requireCapability('billing:write') },
    handler(async (request, reply) => {
      const body = parseBody(request, recordPaymentSchema, 'payment');
      const tenant = tenantOf(request);
      const clinicId = request.tenant.clinicId;
      const settings = readSettings(app.database, clinicId);
      tenant.require('patients', body.patientId);

      if (body.invoiceId) {
        const invoice = tenant.get<Row>('invoices', body.invoiceId);
        if (!invoice) throw ApiError.notFound('Invoice not found.');
        const total = Number(invoice['total_minor']);
        const alreadyPaid = Number(invoice['paid_minor']);
        if (alreadyPaid + body.amountMinor > total) {
          throw ApiError.conflict(
            `That payment exceeds the outstanding balance of ${total - alreadyPaid}.`,
            { outstandingMinor: total - alreadyPaid },
          );
        }
      }

      const now = new Date().toISOString();
      const paymentId = createId('pay');

      const apply = app.database.transaction((): void => {
        tenant.insert('payments', {
          id: paymentId,
          clinic_id: clinicId,
          patient_id: body.patientId,
          invoice_id: nullable(body.invoiceId),
          appointment_id: nullable(body.appointmentId),
          type: body.isDeposit ? 'deposit' : 'payment',
          direction: 'payment',
          amount_minor: body.amountMinor,
          currency: settings.finance.currency,
          method: body.method as PaymentMethod,
          status: 'paid',
          description: body.isDeposit ? 'Booking deposit' : 'Payment received',
          reference: nullable(body.reference),
          performed_by: userIdOf(request),
          performed_at: now,
          is_deposit: body.isDeposit ? 1 : 0,
          note: nullable(body.note),
          created_at: now,
          updated_at: now,
        });

        if (body.invoiceId) {
          const invoice = tenant.get<Row>('invoices', body.invoiceId);
          if (invoice) {
            // Settlement is against the patient share: the insurer's part was
            // never charged to them. Old rows predate the split and fall back
            // to the full total, which the migration backfilled as the share.
            const owed = Number(invoice['patient_share_minor'] ?? invoice['total_minor']);
            const paid = Number(invoice['paid_minor']) + body.amountMinor;
            tenant.update('invoices', body.invoiceId, {
              paid_minor: paid,
              status: statusFor(owed, paid),
              paid_at: paid >= owed ? now : null,
              updated_at: now,
            });
          }
        }

        // A deposit is credited against the appointment it secures.
        if (body.isDeposit && body.appointmentId) {
          const appointment = tenant.get<Row>('appointments', body.appointmentId);
          if (appointment) {
            const depositPaid = Number(appointment['deposit_paid_minor']) + body.amountMinor;
            const depositRequired = Number(appointment['deposit_required_minor']);
            tenant.update('appointments', body.appointmentId, {
              deposit_paid_minor: depositPaid,
              // Paying the required deposit converts a held slot to confirmed.
              status:
                String(appointment['status']) === 'scheduled' &&
                depositRequired > 0 &&
                depositPaid >= depositRequired
                  ? 'confirmed'
                  : String(appointment['status']),
              updated_at: now,
            });
          }
        }
      });
      apply();

      const balance = syncPatientBalance(tenant, body.patientId, now);
      return reply.status(201).send({ id: paymentId, balanceMinor: balance });
    }),
  );

  app.get(
    '/payments',
    { preHandler: requireCapability('billing:read') },
    handler(async (request) => {
      const query = parseQuery(
        request,
        paginationSchema.extend({
          patientId: idSchema.optional(),
          invoiceId: idSchema.optional(),
          direction: z.enum(['charge', 'payment', 'refund']).optional(),
          from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
          to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        }),
      );
      const tenant = tenantOf(request);
      const where: string[] = [];
      const params: string[] = [];
      if (query.patientId) {
        where.push('patient_id = ?');
        params.push(query.patientId);
      }
      if (query.invoiceId) {
        where.push('invoice_id = ?');
        params.push(query.invoiceId);
      }
      if (query.direction) {
        where.push('direction = ?');
        params.push(query.direction);
      }
      if (query.from) {
        where.push('performed_at >= ?');
        params.push(`${query.from}T00:00:00.000Z`);
      }
      if (query.to) {
        where.push('performed_at <= ?');
        params.push(`${query.to}T23:59:59.999Z`);
      }
      const clause = where.length > 0 ? where.join(' AND ') : undefined;
      return {
        items: tenant.page<Row>('payments', {
          where: clause,
          params,
          orderBy: 'performed_at DESC',
          limit: query.limit,
          offset: query.offset,
        }),
        total: tenant.count('payments', clause, params),
      };
    }),
  );

  /** Clinic revenue summary for the finance dashboard. */
  app.get(
    '/finance/summary',
    { preHandler: requireCapability('billing:read') },
    handler(async (request) => {
      const query = parseQuery(
        request,
        z.object({
          from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
          to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        }),
      );
      const tenant = tenantOf(request);
      const from = `${query.from ?? '0000-01-01'}T00:00:00.000Z`;
      const to = `${query.to ?? '9999-12-31'}T23:59:59.999Z`;

      const totals = tenant.withTenant<{
        collected_minor: number | null;
        charged_minor: number | null;
        outstanding_minor: number | null;
        invoice_count: number | null;
      }>(
        `SELECT
           COALESCE(SUM(CASE WHEN direction = 'payment' AND status = 'paid' THEN amount_minor ELSE 0 END), 0) AS collected_minor,
           COALESCE(SUM(CASE WHEN direction = 'charge' THEN amount_minor ELSE 0 END), 0) AS charged_minor,
           COALESCE(SUM(CASE WHEN direction = 'charge' THEN amount_minor ELSE 0 END)
                  - SUM(CASE WHEN direction IN ('payment', 'refund') AND status = 'paid' THEN amount_minor ELSE 0 END), 0) AS outstanding_minor,
           (SELECT COUNT(*) FROM invoices WHERE clinic_id = ? AND created_at >= ? AND created_at <= ?) AS invoice_count
         FROM payments
        WHERE clinic_id = ? AND performed_at >= ? AND performed_at <= ?`,
        [tenant.clinicId, from, to, tenant.clinicId, from, to],
      );

      const byMethod = tenant.withTenant<{ method: string | null; total: number | null }>(
        `SELECT method, COALESCE(SUM(amount_minor), 0) AS total
           FROM payments
          WHERE clinic_id = ? AND direction = 'payment' AND status = 'paid'
            AND performed_at >= ? AND performed_at <= ?
          GROUP BY method`,
        [tenant.clinicId, from, to],
      );

      const overdue = tenant.count('invoices', "status IN ('pending', 'partial') AND due_date < ?", [
        new Date().toISOString().slice(0, 10),
      ]);

      const row = totals[0];
      return {
        currency: readSettings(app.database, request.tenant.clinicId).finance.currency,
        collectedMinor: Math.round(row?.collected_minor ?? 0),
        chargedMinor: Math.round(row?.charged_minor ?? 0),
        outstandingMinor: Math.round(row?.outstanding_minor ?? 0),
        invoiceCount: row?.invoice_count ?? 0,
        overdueInvoices: overdue,
        byMethod: byMethod.map((m) => ({ method: m.method, totalMinor: Math.round(m.total ?? 0) })),
      };
    }),
  );

  /**
   * Contracted insurers (الجهات الضامنة). The coverage percent and caps live
   * here, once, instead of being re-typed on every invoice; patients link to
   * one insurer with their policy number.
   */
  app.get(
    '/insurers',
    { preHandler: requireCapability('billing:read') },
    handler(async (request) => {
      const query = parseQuery(
        request,
        paginationSchema.extend({ active: z.enum(['true', 'false', 'all']).default('all') }),
      );
      const tenant = tenantOf(request);
      const clause = query.active === 'all' ? undefined : query.active === 'true' ? 'is_active = 1' : 'is_active = 0';
      const rows = tenant.page<Row>('insurers', {
        where: clause,
        orderBy: 'name ASC',
        limit: query.limit,
        offset: query.offset,
      });
      return { items: rows.map(toInsurer), total: tenant.count('insurers', clause) };
    }),
  );

  app.post(
    '/insurers',
    { preHandler: requireCapability('billing:write') },
    handler(async (request, reply) => {
      const body = parseBody(request, insurerSchema, 'insurer');
      const tenant = tenantOf(request);
      const now = new Date().toISOString();
      const id = createId('ins');
      tenant.insert('insurers', {
        id,
        clinic_id: request.tenant.clinicId,
        name: body.name,
        name_ar: nullable(body.nameAr),
        coverage_percent: body.coveragePercent,
        annual_limit_minor: body.annualLimitMinor ?? null,
        per_visit_limit_minor: body.perVisitLimitMinor ?? null,
        phone: nullable(body.phone),
        email: nullable(body.email),
        notes: nullable(body.notes),
        is_active: 1,
        created_at: now,
        updated_at: now,
      });
      return reply.status(201).send(toInsurer(tenant.require<Row>('insurers', id)));
    }),
  );

  app.patch(
    '/insurers/:id',
    { preHandler: requireCapability('billing:write') },
    handler(async (request) => {
      const { id } = parseParams(request, z.object({ id: idSchema }));
      const body = parseBody(
        request,
        insurerSchema.partial().extend({ isActive: z.boolean().optional() }),
        'insurer update',
      );
      const tenant = tenantOf(request);
      tenant.require<Row>('insurers', id);
      const values: Record<string, string | number | null> = { updated_at: new Date().toISOString() };
      if (body.name !== undefined) values['name'] = body.name;
      if (body.nameAr !== undefined) values['name_ar'] = nullable(body.nameAr);
      if (body.coveragePercent !== undefined) values['coverage_percent'] = body.coveragePercent;
      if (body.annualLimitMinor !== undefined) values['annual_limit_minor'] = body.annualLimitMinor;
      if (body.perVisitLimitMinor !== undefined) values['per_visit_limit_minor'] = body.perVisitLimitMinor;
      if (body.phone !== undefined) values['phone'] = nullable(body.phone);
      if (body.email !== undefined) values['email'] = nullable(body.email);
      if (body.notes !== undefined) values['notes'] = nullable(body.notes);
      if (body.isActive !== undefined) values['is_active'] = body.isActive ? 1 : 0;
      tenant.update('insurers', id, values);
      return toInsurer(tenant.require<Row>('insurers', id));
    }),
  );

  /**
   * Insurer statement: what this insurer owes right now.
   *
   * Billed is the sum of insurer shares across their invoices; collected is
   * the sum of recorded receipts; outstanding is always the difference, so
   * the account can never drift from its two ledgers.
   */
  app.get(
    '/insurers/:id/statement',
    { preHandler: requireCapability('billing:read') },
    handler(async (request) => {
      const { id } = parseParams(request, z.object({ id: idSchema }));
      const tenant = tenantOf(request);
      const insurer = toInsurer(tenant.require<Row>('insurers', id));

      const billed =
        tenant.withTenant<{ t: number | null }>(
          `SELECT COALESCE(SUM(insurer_share_minor), 0) AS t FROM invoices
            WHERE clinic_id = ? AND insurer_id = ?`,
          [request.tenant.clinicId, id],
        )[0]?.t ?? 0;
      const collected =
        tenant.withTenant<{ t: number | null }>(
          `SELECT COALESCE(SUM(amount_minor), 0) AS t FROM insurer_payments
            WHERE clinic_id = ? AND insurer_id = ?`,
          [request.tenant.clinicId, id],
        )[0]?.t ?? 0;

      const open = tenant.page<Row>('invoices', {
        where: 'insurer_id = ? AND insurer_share_minor > 0',
        params: [id],
        orderBy: 'created_at DESC',
        limit: 100,
        offset: 0,
      });
      // One audit line per invoice: who owes it (name + their insurance
      // reference), how much, and when - so the insurer can match every
      // pound on their side.
      const patientCache = new Map<string, { fullName: string; policyNo: string | null }>();
      const patientOf = (patientId: string): { fullName: string; policyNo: string | null } => {
        const cached = patientCache.get(patientId);
        if (cached) return cached;
        const row = tenant.get<Row>('patients', patientId);
        const entry = {
          fullName: row ? String(row['full_name']) : patientId,
          policyNo: row?.['insurer_policy_no'] ? String(row['insurer_policy_no']) : null,
        };
        patientCache.set(patientId, entry);
        return entry;
      };
      const receipts = tenant.page<Row>('insurer_payments', {
        where: 'insurer_id = ?',
        params: [id],
        orderBy: 'received_at DESC',
        limit: 100,
        offset: 0,
      });

      return {
        insurer,
        billedMinor: billed,
        collectedMinor: collected,
        outstandingMinor: billed - collected,
        invoices: open.map((r) => {
          const patient = patientOf(String(r['patient_id']));
          return {
            id: String(r['id']),
            patientId: String(r['patient_id']),
            patientName: patient.fullName,
            policyNo: patient.policyNo,
            totalMinor: Number(r['total_minor']),
            insurerShareMinor: Number(r['insurer_share_minor']),
            status: String(r['status']),
            createdAt: String(r['created_at']),
          };
        }),
        receipts: receipts.map((r) => ({
          id: String(r['id']),
          amountMinor: Number(r['amount_minor']),
          reference: r['reference'] ? String(r['reference']) : null,
          note: r['note'] ? String(r['note']) : null,
          receivedAt: String(r['received_at']),
        })),
      };
    }),
  );

  /**
   * Record money actually received from an insurer. Refuses more than the
   * outstanding balance: an over-collection is a data-entry mistake, and the
   * books must say so instead of going negative silently.
   */
  app.post(
    '/insurer-payments',
    { preHandler: requireCapability('billing:write') },
    handler(async (request, reply) => {
      const body = parseBody(
        request,
        z.object({
          insurerId: idSchema,
          amountMinor: moneyMinorSchema.refine((v) => v > 0, 'Amount must be greater than zero.'),
          reference: z.string().trim().max(120).nullable().optional(),
          note: z.string().trim().max(500).nullable().optional(),
          receivedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
        }),
        'insurer receipt',
      );
      const tenant = tenantOf(request);
      tenant.require<Row>('insurers', body.insurerId);

      const billed =
        tenant.withTenant<{ t: number | null }>(
          `SELECT COALESCE(SUM(insurer_share_minor), 0) AS t FROM invoices
            WHERE clinic_id = ? AND insurer_id = ?`,
          [request.tenant.clinicId, body.insurerId],
        )[0]?.t ?? 0;
      const collected =
        tenant.withTenant<{ t: number | null }>(
          `SELECT COALESCE(SUM(amount_minor), 0) AS t FROM insurer_payments
            WHERE clinic_id = ? AND insurer_id = ?`,
          [request.tenant.clinicId, body.insurerId],
        )[0]?.t ?? 0;
      const outstanding = billed - collected;
      if (body.amountMinor > outstanding) {
        throw ApiError.badRequest(
          `That exceeds the outstanding balance of ${outstanding} minor units.`,
          [{ path: 'amountMinor', message: 'Collection cannot exceed what the insurer owes.' }],
        );
      }

      const now = new Date().toISOString();
      const id = createId('inp');
      tenant.insert('insurer_payments', {
        id,
        clinic_id: request.tenant.clinicId,
        insurer_id: body.insurerId,
        amount_minor: body.amountMinor,
        reference: nullable(body.reference),
        note: nullable(body.note),
        received_by: userIdOf(request),
        received_at: body.receivedAt ? `${body.receivedAt}T00:00:00.000Z` : now,
        created_at: now,
      });
      return reply.status(201).send({ id, outstandingMinor: outstanding - body.amountMinor });
    }),
  );
}
