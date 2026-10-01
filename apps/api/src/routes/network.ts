/**
 * Patient network routes: registration, phone lookup, import, shared record,
 * doctor directory, and cross-clinic booking.
 *
 * Access model, stated once: a clinic sees a network patient's shared history
 * only through a link, and a link appears only when the patient books, visits,
 * or is imported by staff they attend. Opening the record audits the access.
 * The directory is public the way a phone book is: names, clinics, and how
 * to book - never anything clinical.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { createReadStream, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { z } from 'zod';

import { ApiError, handler, idSchema, parseBody, parseParams, parseQuery } from '../http/errors.js';
import { requireCapability } from '../auth/plugin.js';
import { requirePatient } from './patientapp.js';
import { tenantOf, userIdOf } from '../services/context.js';
import { scoped } from '../db/tenant.js';
import { createPatient } from '../services/patients.js';
import { readSettings } from '../services/settings.js';
import { bookingContextFor, createBooking } from '../services/appointments.js';
import {
  canonicalPhone,
  ensureLink,
  findNetworkByPhone,
  getLink,
  getLinkByLocal,
  getNetworkPatient,
  openSharedRecord,
  registerNetworkPatient,
} from '../services/network.js';

const phoneSchema = z.string().trim().min(6).max(24);
const nameSchema = z.string().trim().min(1).max(80);

const registerSchema = z.object({
  phone: phoneSchema,
  firstName: nameSchema,
  lastName: nameSchema,
  // The patient picks a 6-digit PIN at signup: phone + PIN is the login.
  code: z.string().trim().regex(/^\d{6}$/, 'Code must be 6 digits.'),
  dateOfBirth: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  sex: z.enum(['female', 'male', 'intersex', 'unknown']).optional(),
  bloodGroup: z.string().trim().max(8).nullable().optional(),
  address: z.string().trim().max(400).nullable().optional(),
  city: z.string().trim().max(80).nullable().optional(),
  country: z.string().trim().max(80).nullable().optional(),
  emergencyContactName: z.string().trim().max(120).nullable().optional(),
  emergencyContactPhone: z.string().trim().max(24).nullable().optional(),
  // Basic initial health info only - the history accumulates from visits.
  chronicConditions: z.array(z.string().trim().max(120)).max(20).optional(),
  allergies: z.array(z.string().trim().max(120)).max(20).optional(),
  currentMedications: z.array(z.string().trim().max(200)).max(30).optional(),
});

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

// Registration is public by necessity (it creates the account), so it is
// throttled by IP: a handful of signups per hour per address is plenty for
// real patients and useless for enumeration.
const regAttempts = new Map<string, { count: number; firstAt: number }>();

function checkRegThrottle(ip: string): void {
  const entry = regAttempts.get(ip);
  if (!entry) return;
  if (Date.now() - entry.firstAt > 3600_000) {
    regAttempts.delete(ip);
    return;
  }
  if (entry.count >= 10) {
    throw ApiError.badRequest('Too many registrations. Try again later.');
  }
}

export async function registerNetworkRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/network/register',
    { config: { public: true } },
    handler(async (request, reply) => {
      checkRegThrottle(request.ip);
      const body = parseBody(request, registerSchema, 'registration');
      const phone = canonicalPhone(body.phone);
      if (!phone) throw ApiError.badRequest('Phone number is not a valid international number.');
      // A re-registration must never reset the PIN: the code is set once, at
      // creation. Otherwise anyone could seize any account by re-registering
      // its phone number.
      const already = findNetworkByPhone(app.database, phone);
      if (already) {
        return reply.status(201).send({ id: already.id, phone: already.phone, fullName: already.fullName });
      }
      const profile = registerNetworkPatient(app.database, { ...body, phone });
      app.database
        .prepare('UPDATE network_patients SET code_hash = ?, updated_at = ? WHERE id = ?')
        .run(sha256Hex(body.code), new Date().toISOString(), profile.id);
      const entry = regAttempts.get(request.ip);
      if (!entry) regAttempts.set(request.ip, { count: 1, firstAt: Date.now() });
      else entry.count += 1;
      return reply.status(201).send({ id: profile.id, phone: profile.phone, fullName: profile.fullName });
    }),
  );

  app.post(
    '/auth/network',
    { config: { public: true } },
    handler(async (request) => {
      const body = parseBody(
        request,
        z.object({ phone: phoneSchema, code: z.string().trim().min(4).max(32) }),
        'network sign-in',
      );
      const phone = canonicalPhone(body.phone);
      const row = phone
        ? (app.database.prepare('SELECT * FROM network_patients WHERE phone = ?').get(phone) as
            | Record<string, unknown>
            | undefined)
        : undefined;
      const expected = Buffer.from(
        typeof row?.['code_hash'] === 'string' ? (row['code_hash'] as string) : sha256Hex('no-code-on-file'),
        'hex',
      );
      const actual = Buffer.from(sha256Hex(body.code), 'hex');
      if (!row || expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
        throw ApiError.unauthorized('Incorrect phone number or code.');
      }
      const claims = { role: 'patient', networkPatientId: String(row['id']), phone: String(row['phone']) };
      return {
        token: (app.jwt.sign as unknown as (payload: Record<string, string>) => string)({ ...claims }),
        patient: { networkPatientId: String(row['id']), phone: String(row['phone']) },
      };
    }),
  );

  /** Phone-book lookup: existence plus basic profile, never clinical data. */
  app.get(
    '/network/lookup',
    { preHandler: requireCapability('patients:read') },
    handler(async (request) => {
      const query = parseQuery(request, z.object({ phone: phoneSchema }));
      const phone = canonicalPhone(query.phone);
      if (!phone) throw ApiError.badRequest('Phone number is not a valid international number.');
      const profile = findNetworkByPhone(app.database, phone);
      if (!profile) return { registered: false as const };
      const link = getLink(app.database, request.tenant.clinicId, profile.id);
      return {
        registered: true as const,
        profile: {
          id: profile.id,
          fullName: profile.fullName,
          phone: profile.phone,
          dateOfBirth: profile.dateOfBirth,
          sex: profile.sex,
          verified: profile.verified,
        },
        linkedLocalPatientId: link?.localPatientId ?? null,
      };
    }),
  );

  /**
   * Import a network patient into this clinic: prefilled local chart plus
   * the link that opens their shared history. Idempotent per clinic.
   */
  app.post(
    '/network/import',
    { preHandler: requireCapability('patients:write') },
    handler(async (request, reply) => {
      const body = parseBody(request, z.object({ networkPatientId: idSchema }), 'import');
      const tenant = tenantOf(request);
      const clinicId = request.tenant.clinicId;
      const profile = getNetworkPatient(app.database, body.networkPatientId);
      if (!profile) throw ApiError.notFound('Patient is not registered on the network.');

      const existing = getLink(app.database, clinicId, profile.id);
      if (existing) {
        return { localPatientId: existing.localPatientId, linked: true as const, reused: true as const };
      }

      const settings = readSettings(app.database, clinicId);
      const local = createPatient(
        tenant,
        clinicId,
        {
          firstName: profile.firstName,
          lastName: profile.lastName,
          phone: profile.phone,
          dateOfBirth: profile.dateOfBirth,
          sex: profile.sex as 'female' | 'male' | 'intersex' | 'unknown',
          bloodGroup: profile.bloodGroup,
          address: profile.address,
          city: profile.city,
          country: profile.country,
          emergencyContactName: profile.emergencyContactName,
          emergencyContactPhone: profile.emergencyContactPhone,
          chronicConditions: profile.chronicConditions,
          allergies: profile.allergies,
          currentMedications: profile.currentMedications,
          source: 'import',
          createdBy: userIdOf(request),
        },
        settings.whatsapp.defaultDialCode,
      );
      ensureLink(app.database, clinicId, profile.id, local.id);
      return reply.status(201).send({ localPatientId: local.id, linked: true as const, reused: false as const });
    }),
  );

  /** Resolve the network identity behind a local chart, if any. */
  app.get(
    '/network/by-local/:id',
    { preHandler: requireCapability('patients:read') },
    handler(async (request) => {
      const { id } = parseParams(request, z.object({ id: idSchema }));
      tenantOf(request).require('patients', id);
      const link = getLinkByLocal(app.database, request.tenant.clinicId, id);
      if (!link) throw ApiError.notFound('This patient is not linked to the network yet.');
      return { networkPatientId: link.networkPatientId };
    }),
  );

  /** Full shared history with provenance, auto-linking on first access. */
  app.get(
    '/network/patients/:id/record',
    { preHandler: requireCapability('patients:read') },
    handler(async (request) => {
      const { id } = parseParams(request, z.object({ id: idSchema }));
      const link = getLink(app.database, request.tenant.clinicId, id);
      return openSharedRecord(
        app.database,
        request.tenant.clinicId,
        id,
        link?.localPatientId ?? null,
        request.tenant.user?.id ?? null,
      );
    }),
  );

  /** Public doctor directory: who is on the app and how to reach them. */
  app.get(
    '/directory',
    { config: { public: true } },
    handler(async (request) => {
      void request;
      const clinics = app.database
        .prepare(
          `SELECT id, name, country, phone, slug FROM clinics WHERE is_active = 1 ORDER BY name ASC LIMIT 200`,
        )
        .all() as { id: string; name: string; country: string | null; phone: string | null; slug: string }[];
      const doctors = app.database
        .prepare(
          `SELECT u.id AS id, u.clinic_id AS clinicId, u.full_name AS name, u.specialty AS specialty,
                  c.name AS clinicName, c.phone AS clinicPhone
             FROM users u JOIN clinics c ON c.id = u.clinic_id
            WHERE (u.role = 'doctor' OR (u.role = 'owner' AND u.specialty IS NOT NULL))
              AND u.is_active = 1 AND c.is_active = 1
            ORDER BY c.name ASC, u.full_name ASC LIMIT 500`,
        )
        .all() as { id: string; clinicId: string; name: string; specialty: string | null; clinicName: string; clinicPhone: string | null }[];
      // Insurer names per clinic, so the patient app can badge doctors whose
      // clinic contracts with the patient's own insurer.
      const insurerRows = app.database
        .prepare(
          `SELECT i.clinic_id AS clinicId, i.name AS name FROM insurers i
            JOIN clinics c ON c.id = i.clinic_id
            WHERE i.is_active = 1 AND c.is_active = 1 LIMIT 500`,
        )
        .all() as { clinicId: string; name: string }[];
      const insurersByClinic = new Map<string, string[]>();
      for (const row of insurerRows) {
        const list = insurersByClinic.get(row.clinicId) ?? [];
        list.push(row.name);
        insurersByClinic.set(row.clinicId, list);
      }
      return {
        clinics,
        doctors: doctors.map((d) => ({ ...d, clinicInsurers: insurersByClinic.get(d.clinicId) ?? [] })),
      };
    }),
  );

  /**
   * Cross-clinic booking for a signed-in patient: their network identity
   * carries them into any clinic, creating the local chart and link there.
   */
  app.post(
    '/patient/me/appointments',
    handler(async (request, reply) => {
      const claims = await requirePatient(request);
      const body = parseBody(
        request,
        z.object({
          clinicId: idSchema.optional(),
          startsAt: z.string().refine((v) => !Number.isNaN(Date.parse(v)), 'Must be an ISO timestamp.'),
          reason: z.string().trim().max(500).nullable().optional(),
        }),
        'appointment request',
      );
      // The patient's own network identity - the session can never name
      // anyone else, so cross-clinic booking is safe by construction.
      const networkId =
        claims.networkPatientId ??
        (claims.patientId && claims.clinicId
          ? (getLinkByLocal(app.database, claims.clinicId, claims.patientId)?.networkPatientId ?? null)
          : null);
      if (!networkId) throw ApiError.badRequest('This account is not linked to a network identity.');
      const profile = getNetworkPatient(app.database, networkId);
      if (!profile) throw ApiError.notFound('Network identity not found.');

      const targetClinic = body.clinicId ?? claims.clinicId;
      if (!targetClinic) throw ApiError.badRequest('Choose a clinic.');
      const clinic = app.database.prepare('SELECT id FROM clinics WHERE id = ? AND is_active = 1').get(targetClinic) as
        | { id: string }
        | undefined;
      if (!clinic) throw ApiError.notFound('Clinic not found.');

      // Reuse the linked chart here, or import the network profile on first visit.
      let localId = getLink(app.database, targetClinic, networkId)?.localPatientId ?? null;
      if (!localId) {
        const settings = readSettings(app.database, targetClinic);
        const local = createPatient(
          scoped(app.database, targetClinic),
          targetClinic,
          {
            firstName: profile.firstName,
            lastName: profile.lastName,
            phone: profile.phone,
            dateOfBirth: profile.dateOfBirth,
            sex: profile.sex as 'female' | 'male' | 'intersex' | 'unknown',
            address: profile.address,
            city: profile.city,
            chronicConditions: profile.chronicConditions,
            allergies: profile.allergies,
            currentMedications: profile.currentMedications,
            source: 'import',
            createdBy: null,
          },
          settings.whatsapp.defaultDialCode,
        );
        ensureLink(app.database, targetClinic, networkId, local.id);
        localId = local.id;
      }

      const tenant = scoped(app.database, targetClinic);
      const ctx = bookingContextFor(app.database, targetClinic);
      const appointment = createBooking(
        app.database,
        tenant,
        targetClinic,
        ctx,
        {
          patientId: localId,
          patientName: profile.fullName,
          patientPhone: profile.phone,
          startsAt: new Date(body.startsAt).toISOString(),
          reason: body.reason ?? null,
          source: 'patient_app',
        },
        new Date().toISOString(),
      );
      return reply.status(201).send(appointment);
    }),
  );

  /**
   * The patient fills in their own info: full personal details, basic health
   * info only. The phone is the identity and never changes here; history
   * accumulates from visits, never from self-report.
   */
  app.patch(
    '/patient/me/profile',
    handler(async (request) => {
      const claims = await requirePatient(request);
      const networkId =
        claims.networkPatientId ??
        (claims.patientId && claims.clinicId
          ? (getLinkByLocal(app.database, claims.clinicId, claims.patientId)?.networkPatientId ?? null)
          : null);
      if (!networkId) throw ApiError.notFound('No shared record for this account yet.');
      const body = parseBody(
        request,
        z.object({
          firstName: nameSchema.optional(),
          lastName: nameSchema.optional(),
          dateOfBirth: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
          sex: z.enum(['female', 'male', 'intersex', 'unknown']).optional(),
          bloodGroup: z.string().trim().max(8).nullable().optional(),
          address: z.string().trim().max(400).nullable().optional(),
          city: z.string().trim().max(80).nullable().optional(),
          country: z.string().trim().max(80).nullable().optional(),
          emergencyContactName: z.string().trim().max(120).nullable().optional(),
          emergencyContactPhone: z.string().trim().max(24).nullable().optional(),
          chronicConditions: z.array(z.string().trim().max(120)).max(20).optional(),
          allergies: z.array(z.string().trim().max(120)).max(20).optional(),
          currentMedications: z.array(z.string().trim().max(200)).max(30).optional(),
        }),
        'profile update',
      );
      const existing = getNetworkPatient(app.database, networkId);
      if (!existing) throw ApiError.notFound('Network identity not found.');
      const firstName = body.firstName ?? existing.firstName;
      const lastName = body.lastName ?? existing.lastName;
      const arr = (v: string[] | undefined, fallback: string[]): string =>
        JSON.stringify(v ?? fallback);
      app.database
        .prepare(
          `UPDATE network_patients SET first_name = ?, last_name = ?, full_name = ?,
            date_of_birth = ?, sex = ?, blood_group = ?, address = ?, city = ?, country = ?,
            emergency_contact_name = ?, emergency_contact_phone = ?,
            chronic_conditions = ?, allergies = ?, current_medications = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          firstName,
          lastName,
          `${firstName} ${lastName}`.trim(),
          body.dateOfBirth !== undefined ? body.dateOfBirth : existing.dateOfBirth,
          body.sex ?? existing.sex,
          body.bloodGroup !== undefined ? body.bloodGroup : existing.bloodGroup,
          body.address !== undefined ? body.address : existing.address,
          body.city !== undefined ? body.city : existing.city,
          body.country !== undefined ? body.country : existing.country,
          body.emergencyContactName !== undefined ? body.emergencyContactName : existing.emergencyContactName,
          body.emergencyContactPhone !== undefined ? body.emergencyContactPhone : existing.emergencyContactPhone,
          arr(body.chronicConditions, existing.chronicConditions),
          arr(body.allergies, existing.allergies),
          arr(body.currentMedications, existing.currentMedications),
          new Date().toISOString(),
          networkId,
        );
      return getNetworkPatient(app.database, networkId);
    }),
  );
  /** The patient's own network profile, for viewing and editing. */
  app.get(
    '/patient/me/profile',
    handler(async (request) => {
      const claims = await requirePatient(request);
      const networkId =
        claims.networkPatientId ??
        (claims.patientId && claims.clinicId
          ? (getLinkByLocal(app.database, claims.clinicId, claims.patientId)?.networkPatientId ?? null)
          : null);
      if (!networkId) throw ApiError.notFound('No shared record for this account yet.');
      const profile = getNetworkPatient(app.database, networkId);
      if (!profile) throw ApiError.notFound('Network identity not found.');
      // Insurers live on the local charts: collect one entry per clinic so
      // the patient sees who covers them where.
      const links = app.database
        .prepare('SELECT * FROM clinic_links WHERE network_patient_id = ? ORDER BY created_at ASC')
        .all(networkId) as Record<string, unknown>[];
      const insurers: { clinicId: string; clinicName: string; insurerName: string; coveragePercent: number }[] = [];
      for (const link of links) {
        const cid = String(link['clinic_id']);
        const local = app.database.prepare('SELECT insurer_id FROM patients WHERE id = ?').get(
          String(link['local_patient_id']),
        ) as { insurer_id: string | null } | undefined;
        if (!local?.insurer_id) continue;
        const insurer = app.database.prepare('SELECT name, coverage_percent FROM insurers WHERE id = ?').get(
          local.insurer_id,
        ) as { name: string; coverage_percent: number } | undefined;
        if (!insurer) continue;
        const clinic = app.database.prepare('SELECT name FROM clinics WHERE id = ?').get(cid) as
          | { name: string }
          | undefined;
        insurers.push({
          clinicId: cid,
          clinicName: clinic?.name ?? cid,
          insurerName: insurer.name,
          coveragePercent: Number(insurer.coverage_percent),
        });
      }
      return { ...profile, insurers };
    }),
  );

  /**
   * Profile photo: small square image, stored as a file. Shown in the
   * patient app and to treating doctors next to the shared record.
   */
  app.post(
    '/patient/me/avatar',
    handler(async (request, reply) => {
      const claims = await requirePatient(request);
      const networkId =
        claims.networkPatientId ??
        (claims.patientId && claims.clinicId
          ? (getLinkByLocal(app.database, claims.clinicId, claims.patientId)?.networkPatientId ?? null)
          : null);
      if (!networkId) throw ApiError.notFound('No shared record for this account yet.');
      const body = parseBody(
        request,
        z.object({
          mimeType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
          fileBase64: z.string().min(1).max(3_000_000),
        }),
        'avatar',
      );
      if (!/^[A-Za-z0-9+/=\r\n]+$/.test(body.fileBase64)) {
        throw ApiError.badRequest('File content is not valid base64.');
      }
      const bytes = Buffer.from(body.fileBase64, 'base64');
      if (bytes.length === 0 || bytes.length > 2 * 1024 * 1024) {
        throw ApiError.badRequest('Photo must be between 1 byte and 2 MB.');
      }
      const ext = body.mimeType === 'image/png' ? 'png' : body.mimeType === 'image/webp' ? 'webp' : 'jpg';
      const dir = resolve(process.env.UPLOADS_DIR ?? 'uploads', 'avatars');
      mkdirSync(dir, { recursive: true });
      const name = `${networkId}.${ext}`;
      writeFileSync(join(dir, name), bytes);
      app.database.prepare('UPDATE network_patients SET avatar_path = ?, updated_at = ? WHERE id = ?').run(
        name,
        new Date().toISOString(),
        networkId,
      );
      return reply.status(201).send({ ok: true });
    }),
  );

  /** Serve an avatar: to the patient themselves, or to a linked clinic. */
  app.get(
    '/network/avatars/:id',
    handler(async (request, reply) => {
      const { id } = parseParams(request, z.object({ id: idSchema }));
      const row = app.database.prepare('SELECT avatar_path FROM network_patients WHERE id = ?').get(id) as
        | { avatar_path: string | null }
        | undefined;
      if (!row?.avatar_path) throw ApiError.notFound('No photo on file.');

      // Exactly two audiences: the patient themselves, or staff of a clinic
      // with a link. Anything else - including no session - fails closed.
      // A missing link answers 404 (not 403) so one clinic cannot probe
      // whether an id exists in another.
      let allowed = false;
      try {
        const claims = await request.jwtVerify<{ role?: string; networkPatientId?: string }>();
        if (claims.role === 'patient') {
          allowed = claims.networkPatientId === id;
        } else {
          const staffClinic = request.tenant?.clinicId;
          allowed = !!staffClinic && getLink(app.database, staffClinic, id) !== null;
        }
      } catch {
        allowed = false;
      }
      if (!allowed) throw ApiError.notFound('No photo on file.');

      const dir = resolve(process.env.UPLOADS_DIR ?? 'uploads', 'avatars');
      const absolute = resolve(dir, row.avatar_path);
      if (absolute !== dir && !absolute.startsWith(dir + sep)) throw ApiError.notFound('No photo on file.');
      if (!existsSync(absolute)) throw ApiError.notFound('No photo on file.');
      const mime = absolute.endsWith('.png') ? 'image/png' : absolute.endsWith('.webp') ? 'image/webp' : 'image/jpeg';
      return reply.header('content-type', mime).header('cache-control', 'private, max-age=3600').send(createReadStream(absolute));
    }),
  );

  /** The patient's own shared record, across every clinic they attend. */  app.get(
    '/patient/me/record',
    handler(async (request) => {
      const claims = await requirePatient(request);
      const networkId =
        claims.networkPatientId ??
        (claims.patientId && claims.clinicId
          ? (getLinkByLocal(app.database, claims.clinicId, claims.patientId)?.networkPatientId ?? null)
          : null);
      if (!networkId) throw ApiError.notFound('No shared record for this account yet.');
      // Read-only for self: aggregate across their links. The reader audits
      // with a null actor, marking it as patient self-access.
      const links = app.database
        .prepare('SELECT * FROM clinic_links WHERE network_patient_id = ? ORDER BY created_at ASC')
        .all(networkId) as Record<string, unknown>[];
      const first = links[0];
      if (!first) return { profile: getNetworkPatient(app.database, networkId), clinics: [] };
      return openSharedRecord(
        app.database,
        String(first['clinic_id']),
        networkId,
        String(first['local_patient_id']),
        null,
      );
    }),
  );
}
