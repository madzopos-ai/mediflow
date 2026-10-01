/**
 * Patient app: access codes, patient login, and self-service endpoints.
 *
 * The clinic - not WhatsApp, not an SMS vendor - onboards the patient: staff
 * generate a one-time 6-digit code, the patient installs the PWA and signs in
 * with phone + code. From then on booking, reminders, and the medication
 * schedule all run inside the app, which is the whole point of this module.
 *
 * Patient sessions are JWTs like staff sessions but carry role `patient` and
 * are fenced to exactly one patient id. Every self endpoint re-checks that
 * fence; a patient can never name another id.
 */

import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { createId } from '@mediflow/shared';

import { ApiError, handler, idSchema, parseBody, parseParams } from '../http/errors.js';
import { requireCapability } from '../auth/plugin.js';
import { scoped } from '../db/tenant.js';
import { toAppointment, toPatient, type Row } from '../db/mappers.js';
import { tenantOf } from '../services/context.js';
import { cancelAppointment } from '../services/appointments.js';
import { toPrescription, toRequestedTest } from './visitflow.js';

export interface PatientClaims {
  role: 'patient';
  patientId?: string;
  clinicId?: string;
  networkPatientId?: string;
  phone: string;
}

function signPatient(app: FastifyInstance, claims: PatientClaims): string {
  // Patient claims are not staff sessions; sign the raw payload instead of
  // going through the staff SessionUser type.
  return (app.jwt.sign as unknown as (payload: Record<string, string>) => string)({ ...claims });
}

export async function requirePatient(request: FastifyRequest): Promise<PatientClaims> {
  let claims: PatientClaims;
  try {
    claims = await request.jwtVerify<PatientClaims>();
  } catch {
    throw ApiError.unauthorized('Authentication required.');
  }
  if (claims.role !== 'patient' || (!claims.networkPatientId && !(claims.patientId && claims.clinicId))) {
    throw ApiError.forbidden('This endpoint is for patient accounts.');
  }
  return claims;
}

/** Same fence as staff tenanting, narrowed to one patient. */
function patientTenant(request: FastifyRequest, claims: PatientClaims): void {
  if (!claims.clinicId) throw ApiError.forbidden('This endpoint needs a clinic session.');
  request.tenant = {
    user: null,
    clinicId: claims.clinicId,
    db: scoped(request.server.database, claims.clinicId),
    isAuthenticated: true,
    can: () => false,
    hasRole: () => false,
  };
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function phoneCandidates(raw: string): string[] {
  const compact = raw.replace(/[\s\-().]/g, '');
  const out = new Set<string>();
  if (compact) out.add(compact);
  const digits = compact.replace(/\D/g, '');
  if (digits) {
    out.add(`+${digits}`);
    if (compact.startsWith('00')) out.add(`+${compact.slice(2)}`);
  }
  return [...out];
}

const MAX_ATTEMPTS = 10;
const WINDOW_MS = 15 * 60 * 1000;
const attempts = new Map<string, { count: number; firstAt: number }>();

function checkThrottle(key: string): void {
  const entry = attempts.get(key);
  if (!entry) return;
  if (Date.now() - entry.firstAt > WINDOW_MS) {
    attempts.delete(key);
    return;
  }
  if (entry.count >= MAX_ATTEMPTS) {
    throw ApiError.unauthorized('Too many attempts. Try again later.');
  }
}

function recordFailure(key: string): void {
  const entry = attempts.get(key);
  if (!entry || Date.now() - entry.firstAt > WINDOW_MS) {
    attempts.set(key, { count: 1, firstAt: Date.now() });
    return;
  }
  entry.count += 1;
  attempts.set(key, entry);
}

export async function registerPatientAppRoutes(app: FastifyInstance): Promise<void> {
  // Staff hand the patient a code once. It is returned here and never listed
  // again; only the hash is stored.
  app.post(
    '/patients/:id/access-code',
    { preHandler: requireCapability('patients:write') },
    handler(async (request) => {
      const { id } = parseParams(request, z.object({ id: idSchema }));
      const tenant = tenantOf(request);
      tenant.require<Row>('patients', id);
      const code = String(randomInt(100_000, 1_000_000));
      const now = new Date().toISOString();
      tenant.db
        .prepare(
          `INSERT INTO patient_access_codes (id, clinic_id, patient_id, code_hash, revoked, created_at)
           VALUES (?, ?, ?, ?, 0, ?)
           ON CONFLICT(clinic_id, patient_id) DO UPDATE SET code_hash = excluded.code_hash, revoked = 0, created_at = excluded.created_at`,
        )
        .run(createId('pac'), request.tenant.clinicId, id, sha256Hex(code), now);
      return { patientId: id, code };
    }),
  );

  app.post(
    '/auth/patient',
    { config: { public: true } },
    handler(async (request) => {
      const body = parseBody(
        request,
        z.object({ phone: z.string().trim().min(6).max(24), code: z.string().trim().min(4).max(32) }),
        'patient sign-in',
      );
      const key = body.phone;
      checkThrottle(key);

      let match: { id: string; clinic_id: string; phone: string } | undefined;
      for (const candidate of phoneCandidates(body.phone)) {
        match = app.database
          .prepare(
            `SELECT id, clinic_id, phone FROM patients
              WHERE (phone = ? OR whatsapp_number = ?) AND is_active = 1 LIMIT 1`,
          )
          .get(candidate, candidate) as typeof match;
        if (match) break;
      }
      if (!match) {
        recordFailure(key);
        throw ApiError.unauthorized('Incorrect phone number or code.');
      }

      const row = app.database
        .prepare(
          `SELECT code_hash FROM patient_access_codes
            WHERE clinic_id = ? AND patient_id = ? AND revoked = 0`,
        )
        .get(match.clinic_id, match.id) as { code_hash: string } | undefined;
      // Always compare something so a missing code is not measurably faster.
      const expected = Buffer.from(row?.code_hash ?? sha256Hex('no-code-on-file'), 'hex');
      const actual = Buffer.from(sha256Hex(body.code), 'hex');
      if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
        recordFailure(key);
        throw ApiError.unauthorized('Incorrect phone number or code.');
      }
      attempts.delete(key);

      // Bridge to the network identity: find the link, or migrate this
      // legacy clinic patient onto the network from their own row.
      const { ensureLink: ensureClinicLink, getLinkByLocal, registerNetworkPatient } = await import(
        '../services/network.js'
      );
      let link = getLinkByLocal(app.database, match.clinic_id, match.id);
      if (!link) {
        const local = app.database.prepare('SELECT * FROM patients WHERE id = ?').get(match.id) as Record<
          string,
          unknown
        >;
        const profile = registerNetworkPatient(app.database, {
          phone: match.phone,
          firstName: String(local?.['first_name'] ?? 'Patient'),
          lastName: String(local?.['last_name'] ?? ''),
          dateOfBirth: typeof local?.['date_of_birth'] === 'string' ? (local['date_of_birth'] as string) : null,
          sex: typeof local?.['sex'] === 'string' ? (local['sex'] as string) : undefined,
          address: typeof local?.['address'] === 'string' ? (local['address'] as string) : null,
          city: typeof local?.['city'] === 'string' ? (local['city'] as string) : null,
        });
        link = ensureClinicLink(app.database, match.clinic_id, profile.id, match.id);
      }

      const claims: PatientClaims = {
        role: 'patient',
        patientId: match.id,
        clinicId: match.clinic_id,
        networkPatientId: link.networkPatientId,
        phone: match.phone,
      };
      return {
        token: signPatient(app, claims),
        patient: { id: match.id, clinicId: match.clinic_id, phone: match.phone, networkPatientId: link.networkPatientId },
      };
    }),
  );

  /** Clinic-scoped self endpoints: require the home-clinic session. */
  async function self(request: FastifyRequest): Promise<Required<Pick<PatientClaims, 'patientId' | 'clinicId'>> & PatientClaims> {
    const claims = await requirePatient(request);
    if (!claims.patientId || !claims.clinicId) {
      throw ApiError.forbidden('This endpoint needs a clinic session.');
    }
    patientTenant(request, claims);
    return claims as Required<Pick<PatientClaims, 'patientId' | 'clinicId'>> & PatientClaims;
  }

  app.get(
    '/patient/me',
    handler(async (request) => {
      const claims = await self(request);
      const patient = toPatient(tenantOf(request).require<Row>('patients', claims.patientId));
      return patient;
    }),
  );

  app.get(
    '/patient/me/appointments',
    handler(async (request) => {
      const claims = await self(request);
      const tenant = tenantOf(request);
      const now = new Date().toISOString();
      const rows = tenant.page<Row>('appointments', {
        where: 'patient_id = ? AND starts_at >= ? AND status NOT IN (?, ?)',
        params: [claims.patientId, now, 'cancelled', 'no_show'],
        orderBy: 'starts_at ASC',
        limit: 20,
        offset: 0,
      });
      return { items: rows.map(toAppointment) };
    }),
  );

  // NOTE: POST /patient/me/appointments lives in routes/network.ts now: the
  // network version accepts an optional clinicId for cross-clinic booking and
  // falls back to the session clinic, so it covers this case exactly.

  app.post(
    '/patient/me/appointments/:id/cancel',
    handler(async (request) => {
      const claims = await requirePatient(request);
      const { id } = parseParams(request, z.object({ id: idSchema }));
      // Clinic session: the home chart. Network session: find the appointment
      // across the patient's own links - it must be theirs, live, and the
      // cancellation runs in its home clinic scope.
      if (claims.patientId && claims.clinicId) {
        const tenant = scoped(request.server.database, claims.clinicId);
        const existing = toAppointment(tenant.require<Row>('appointments', id));
        if (existing.patientId !== claims.patientId) {
          throw ApiError.notFound('Appointment not found.');
        }
        if (existing.status === 'completed' || existing.status === 'cancelled') {
          throw ApiError.conflict(`Cannot cancel an appointment that is "${existing.status}".`);
        }
        return cancelAppointment(tenant, id, null, 'Cancelled by patient.');
      }
      if (!claims.networkPatientId) throw ApiError.forbidden('This endpoint needs a clinic session.');
      const links = request.server.database
        .prepare('SELECT * FROM clinic_links WHERE network_patient_id = ?')
        .all(claims.networkPatientId) as Record<string, unknown>[];
      for (const link of links) {
        const cid = String(link['clinic_id']);
        const tenant = scoped(request.server.database, cid);
        const row = tenant.get<Row>('appointments', id);
        if (!row) continue;
        const existing = toAppointment(row);
        if (existing.patientId !== String(link['local_patient_id'])) continue;
        if (existing.status === 'completed' || existing.status === 'cancelled') {
          throw ApiError.conflict(`Cannot cancel an appointment that is "${existing.status}".`);
        }
        return cancelAppointment(tenant, id, null, 'Cancelled by patient.');
      }
      throw ApiError.notFound('Appointment not found.');
    }),
  );

  app.get(
    '/patient/me/prescriptions',
    handler(async (request) => {
      const claims = await self(request);
      const tenant = tenantOf(request);
      const rows = tenant.page<Row>('prescriptions', {
        where: 'patient_id = ? AND status = ?',
        params: [claims.patientId, 'active'],
        orderBy: 'created_at DESC',
        limit: 20,
        offset: 0,
      });
      return { items: rows.map(toPrescription) };
    }),
  );

  app.get(
    '/patient/me/tests',
    handler(async (request) => {
      const claims = await self(request);
      const tenant = tenantOf(request);
      const rows = tenant.page<Row>('requested_tests', {
        where: 'patient_id = ? AND status = ?',
        params: [claims.patientId, 'requested'],
        orderBy: 'created_at DESC',
        limit: 50,
        offset: 0,
      });
      return { items: rows.map(toRequestedTest) };
    }),
  );

  app.get(
    '/patient/me/reminders',
    handler(async (request) => {
      const claims = await self(request);
      const tenant = tenantOf(request);
      const now = new Date().toISOString();
      const appts = new Map(
        tenant
          .all<Row>('appointments', 'patient_id = ?', [claims.patientId])
          .map((r) => [String(r['id']), String(r['starts_at'])]),
      );
      const mine = [...appts.keys()];
      if (mine.length === 0) return { items: [] };
      const placeholders = mine.map(() => '?').join(',');
      const rows = tenant.withTenant<Row>(
        `SELECT * FROM reminders WHERE clinic_id = ? AND appointment_id IN (${placeholders})
           AND status = 'scheduled' AND scheduled_for >= ? ORDER BY scheduled_for ASC LIMIT 50`,
        [claims.clinicId, ...mine, now],
      );
      return {
        items: rows.map((r) => ({
          id: String(r['id']),
          scheduledFor: String(r['scheduled_for']),
          template: String(r['template']),
          appointmentStartsAt: appts.get(String(r['appointment_id'])) ?? null,
        })),
      };
    }),
  );

  /**
   * Patient billing transparency: the patient's own invoices, what is settled
   * vs still owed, and their recent payments. Fenced to the session patient -
   * the query filters by claims.patientId, so one patient can never see
   * another's ledger. All money stays in integer minor units (see finance.ts).
   */
  app.get(
    '/patient/me/invoices',
    handler(async (request) => {
      const claims = await self(request);
      const tenant = tenantOf(request);
      const invoices = tenant.page<Row>('invoices', {
        where: 'patient_id = ?',
        params: [claims.patientId],
        orderBy: 'created_at DESC',
        limit: 50,
        offset: 0,
      });
      const payments = tenant.page<Row>('payments', {
        where: "patient_id = ? AND direction = 'payment'",
        params: [claims.patientId],
        orderBy: 'created_at DESC',
        limit: 50,
        offset: 0,
      });
      const billed = invoices.reduce((sum, r) => sum + Number(r['patient_share_minor'] ?? 0), 0);
      const paid = invoices.reduce((sum, r) => sum + Number(r['paid_minor'] ?? 0), 0);
      return {
        summary: {
          billedMinor: billed,
          paidMinor: paid,
          outstandingMinor: Math.max(0, billed - paid),
          currency: invoices[0] ? String(invoices[0]['currency'] ?? '') : '',
        },
        invoices: invoices.map((r) => ({
          id: String(r['id']),
          number: String(r['number'] ?? r['id']),
          totalMinor: Number(r['total_minor'] ?? 0),
          patientShareMinor: Number(r['patient_share_minor'] ?? 0),
          paidMinor: Number(r['paid_minor'] ?? 0),
          insurerShareMinor: Number(r['insurer_share_minor'] ?? 0),
          status: String(r['status'] ?? 'pending'),
          currency: String(r['currency'] ?? ''),
          createdAt: String(r['created_at'] ?? ''),
        })),
        payments: payments.map((r) => ({
          id: String(r['id']),
          amountMinor: Number(r['amount_minor'] ?? 0),
          method: r['method'] ? String(r['method']) : null,
          status: String(r['status'] ?? 'pending'),
          createdAt: String(r['created_at'] ?? ''),
        })),
      };
    }),
  );
}
