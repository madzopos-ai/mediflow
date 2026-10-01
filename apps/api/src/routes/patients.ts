/**
 * Patient endpoints.
 *
 * The patient list is the highest-traffic read in the app, so it is paginated,
 * capped, and searchable through the denormalised `search_blob`. Search input
 * is always bound as a parameter - never interpolated - and LIKE wildcards in
 * user input are escaped so a query of `%` does not return the whole table.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { SEXES, ageFromDob, bmiFrom, todayInTz } from '@mediflow/shared';

import {
  ApiError,
  handler,
  idSchema,
  paginationSchema,
  parseBody,
  parseQuery, parseParams } from '../http/errors.js';
import { requireCapability } from '../auth/plugin.js';
import { clinicTimezone, readSettings } from './clinic.js';
import { bit, jsonColumn, nullable, toPatient, toVitalReading, type Row } from '../db/mappers.js';
import {
  buildSearchBlob,
  createPatient,
  nextMrn,
  normalizePatientPhone,
  type CreatePatientInput,
} from '../services/patients.js';
import { tenantOf } from '../services/context.js';

const createSchema = z.object({
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().min(1).max(80),
  fullName: z.string().trim().max(160).optional(),
  phone: z.string().trim().min(6).max(24),
  whatsappNumber: z.string().trim().max(24).nullable().optional(),
  email: z.string().trim().email().max(254).nullable().optional(),
  nationalId: z.string().trim().max(64).nullable().optional(),
  // A chart without age, address, height and weight is clinically useless, so
  // staff creation requires them. Public booking and inbound WhatsApp use
  // narrower paths with their own schemas and stay unaffected.
  dateOfBirth: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be yyyy-mm-dd.')
    .refine((v) => v <= new Date().toISOString().slice(0, 10), 'Date of birth cannot be in the future.'),
  sex: z.enum(SEXES).optional(),
  bloodGroup: z.string().trim().max(8).nullable().optional(),
  heightCm: z.number().min(20).max(260),
  weightKg: z.number().min(0.5).max(500),
  address: z.string().trim().min(2).max(400),
  city: z.string().trim().max(80).nullable().optional(),
  country: z.string().trim().max(80).nullable().optional(),
  emergencyContactName: z.string().trim().max(120).nullable().optional(),
  emergencyContactPhone: z.string().trim().max(24).nullable().optional(),
  preferredLanguage: z.enum(['en', 'ar']).optional(),
  whatsappOptIn: z.boolean().optional(),
  marketingOptIn: z.boolean().optional(),
  chronicConditions: z.array(z.string().max(120)).max(50).optional(),
  allergies: z.array(z.string().max(120)).max(50).optional(),
  currentMedications: z.array(z.string().max(200)).max(100).optional(),
  pastSurguries: z.array(z.string().max(200)).max(50).optional(),
  familyHistory: z.array(z.string().max(200)).max(50).optional(),
  notes: z.string().max(4000).nullable().optional(),
  tags: z.array(z.string().max(40)).max(30).optional(),
  insurerId: idSchema.nullable().optional(),
  insurerPolicyNo: z.string().trim().max(64).nullable().optional(),
});

const updateSchema = createSchema
  .partial()
  .extend({ isActive: z.boolean().optional(), archivedAt: z.string().nullable().optional() });

const listSchema = paginationSchema.extend({
  q: z.string().trim().max(120).optional(),
  active: z
    .enum(['true', 'false', 'all'])
    .default('true')
    .transform((v) => v as 'true' | 'false' | 'all'),
  hasAlert: z.enum(['true', 'false']).optional(),
  sort: z.enum(['name', 'recent', 'balance']).default('name'),
});

/** Escape LIKE wildcards so a user typing "%" searches for a literal percent. */
function likeTerm(raw: string): string {
  return `%${raw.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

export async function registerPatientRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/patients',
    { preHandler: requireCapability('patients:read') },
    handler(async (request) => {
      const query = parseQuery(request, listSchema);
      const db = tenantOf(request);

      const where: string[] = [];
      const params: (string | number)[] = [];

      if (query.active === 'true') where.push('is_active = 1');
      if (query.active === 'false') where.push('is_active = 0');

      if (query.q) {
        where.push("search_blob LIKE ? ESCAPE '\\'");
        params.push(likeTerm(query.q.toLowerCase()));
      }

      const clause = where.length > 0 ? where.join(' AND ') : undefined;
      const total = db.count('patients', clause, params);

      const order =
        query.sort === 'recent'
          ? 'created_at DESC'
          : query.sort === 'balance'
            ? 'balance_minor DESC'
            : 'full_name COLLATE NOCASE ASC';

      const rows = db.page<Row>('patients', {
        where: clause,
        params,
        orderBy: order,
        limit: query.limit,
        offset: query.offset,
      });

      return {
        items: rows.map(toPatient),
        total,
        limit: query.limit,
        offset: query.offset,
      };
    }),
  );

  app.get(
    '/patients/:id',
    { preHandler: requireCapability('patients:read') },
    handler(async (request) => {
      const { id } = parseParams(request, z.object({ id: idSchema }));
      const db = tenantOf(request);
      // `get` is tenant-bound, so a patient from another clinic returns 404.
      const row = db.get<Row>('patients', id);
      if (!row) throw ApiError.notFound('Patient not found.');
      return toPatient(row);
    }),
  );

  /** Everything the medical-record screen needs, in one round trip. */
  app.get(
    '/patients/:id/overview',
    { preHandler: requireCapability('patients:read') },
    handler(async (request) => {
      const { id } = parseParams(request, z.object({ id: idSchema }));
      const db = tenantOf(request);
      const patient = toPatient(db.require<Row>('patients', id));
      const clinicTz = clinicTimezone(app.database, request.tenant.clinicId);
      const now = new Date().toISOString();

      // The chart screen shows a bounded, most-recent-first slice of each
      // related table. `RECENT_LIMIT` keeps the payload predictable instead of
      // loading a patient's entire history into one response.
      const RECENT_LIMIT = 20;
      const recent = (table: string, where: string, params: (string | number | null)[], orderBy: string) =>
        db.page<Row>(table, { where, params, orderBy, limit: RECENT_LIMIT, offset: 0 });

      const vitals = recent('vital_readings', 'patient_id = ?', [id], 'measured_at DESC').map(toVitalReading);
      const visits = recent('visits', 'patient_id = ?', [id], 'created_at DESC');
      const appointments = recent('appointments', 'patient_id = ?', [id], 'starts_at DESC');
      const followUps = recent('follow_ups', 'patient_id = ?', [id], 'next_due_at ASC');
      const documents = recent('documents', 'patient_id = ?', [id], 'created_at DESC');
      const alerts = recent('clinical_alerts', 'patient_id = ? AND status != ?', [id, 'resolved'], 'created_at DESC');
      const invoices = recent('invoices', 'patient_id = ?', [id], 'created_at DESC');

      return {
        patient,
        ageYears: patient.dateOfBirth
          ? ageFromDob(patient.dateOfBirth, todayInTz(clinicTz, new Date(now)))
          : patient.ageYears,
        vitals,
        visits: visits.map((v) => ({
          id: String(v['id']),
          visitType: String(v['visit_type']),
          chiefComplaint: v['chief_complaint'] ? String(v['chief_complaint']) : null,
          diagnosis: v['diagnosis'] ? String(v['diagnosis']) : null,
          notes: v['notes'] ? String(v['notes']) : null,
          createdAt: String(v['created_at']),
        })),
        appointments: appointments.map((a) => ({
          id: String(a['id']),
          startsAt: String(a['starts_at']),
          status: String(a['status']),
          reason: v0(a['reason']),
          doctorName: v0(a['doctor_name']),
        })),
        followUps: followUps.map((f) => ({
          id: String(f['id']),
          name: String(f['name']),
          status: String(f['status']),
          nextDueAt: String(f['next_due_at']),
          adherencePercent: Number(f['adherence_percent'] ?? 0),
        })),
        documents: documents.map((d) => ({
          id: String(d['id']),
          kind: String(d['kind']),
          fileName: String(d['file_name']),
          mimeType: String(d['mime_type']),
          status: String(d['status']),
          createdAt: String(d['created_at']),
        })),
        alerts: alerts.map((a) => ({
          id: String(a['id']),
          kind: String(a['kind']),
          severity: String(a['severity']),
          status: String(a['status']),
          title: String(a['title']),
          body: String(a['body']),
          createdAt: String(a['created_at']),
        })),
        invoices: invoices.map((i) => ({
          id: String(i['id']),
          number: String(i['number']),
          status: String(i['status']),
          totalMinor: Number(i['total_minor'] ?? 0),
          paidMinor: Number(i['paid_minor'] ?? 0),
        })),
      };
    }),
  );

  app.post(
    '/patients',
    { preHandler: requireCapability('patients:write') },
    handler(async (request, reply) => {
      const body = parseBody(request, createSchema, 'patient');
      const settings = readSettings(app.database, request.tenant.clinicId);
      if (body.insurerId) {
        // A mistyped insurer must fail here, not surface as a billing
        // surprise months later. And an insurer link without the patient's
        // policy number is useless at claim time, so it is required too.
        tenantOf(request).require<Row>('insurers', body.insurerId);
        if (!body.insurerPolicyNo) {
          throw ApiError.badRequest('An insurance policy number is required with an insurer.', [
            { path: 'insurerPolicyNo', message: 'Ask the patient for their insurance reference number.' },
          ]);
        }
      }
      const input: CreatePatientInput = {
        ...body,
        createdBy: request.tenant.user?.id ?? null,
      };
      const patient = createPatient(
        tenantOf(request),
        request.tenant.clinicId,
        input,
        settings.whatsapp.defaultDialCode,
      );
      // Every patient is a network patient from birth: register the phone
      // identity (or attach to the existing one) and link this chart, so any
      // clinic they attend later finds them by phone. Best-effort by design:
      // a network hiccup must never fail a local registration.
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
          bloodGroup: patient.bloodGroup === 'unknown' ? null : patient.bloodGroup,
          address: patient.address,
          city: patient.city,
          chronicConditions: patient.chronicConditions,
          allergies: patient.allergies,
          currentMedications: patient.currentMedications,
        });
        linkNetwork(app.database, request.tenant.clinicId, profile.id, patient.id);
      } catch (error) {
        request.log.warn({ err: error }, 'Network registration skipped for new patient.');
      }
      return reply.status(201).send(patient);
    }),
  );

  app.patch(
    '/patients/:id',
    { preHandler: requireCapability('patients:write') },
    handler(async (request) => {
      const { id } = parseParams(request, z.object({ id: idSchema }));
      const body = parseBody(request, updateSchema, 'patient update');
      const db = tenantOf(request);
      const existing = db.get<Row>('patients', id);
      if (!existing) throw ApiError.notFound('Patient not found.');

      const settings = readSettings(app.database, request.tenant.clinicId);
      const now = new Date().toISOString();
      const values: Record<string, string | number | null> = { updated_at: now };

      if (body.firstName !== undefined) values['first_name'] = body.firstName;
      if (body.lastName !== undefined) values['last_name'] = body.lastName;
      if (body.fullName !== undefined) values['full_name'] = body.fullName;
      if (body.phone !== undefined || body.whatsappNumber !== undefined) {
        // Re-normalise whenever either number changes, so a bad edit is
        // rejected here rather than silently breaking messaging later.
        const phone = body.phone ?? String(existing['phone']);
        const whatsapp = body.whatsappNumber ?? v0(existing['whatsapp_number']);
        const normalized = normalizePatientPhone(phone, settings.whatsapp.defaultDialCode, whatsapp);
        values['phone'] = normalized.phone;
        values['whatsapp_number'] = normalized.whatsappNumber;
      }
      if (body.email !== undefined) values['email'] = nullable(body.email);
      if (body.nationalId !== undefined) values['national_id'] = nullable(body.nationalId);
      if (body.dateOfBirth !== undefined) values['date_of_birth'] = nullable(body.dateOfBirth);
      if (body.sex !== undefined) values['sex'] = body.sex;
      if (body.bloodGroup !== undefined) values['blood_group'] = nullable(body.bloodGroup);
      if (body.heightCm !== undefined) values['height_cm'] = body.heightCm;
      if (body.weightKg !== undefined) values['weight_kg'] = body.weightKg;
      if (body.address !== undefined) values['address'] = nullable(body.address);
      if (body.city !== undefined) values['city'] = nullable(body.city);
      if (body.insurerId !== undefined) {
        if (body.insurerId) db.require<Row>('insurers', body.insurerId);
        values['insurer_id'] = nullable(body.insurerId);
      }
      if (body.insurerPolicyNo !== undefined) values['insurer_policy_no'] = nullable(body.insurerPolicyNo);
      // The link is useless at claim time without the patient's reference
      // number, so the resulting state - not just this patch - must have it.
      const effectiveInsurer =
        body.insurerId !== undefined ? body.insurerId : v0(existing['insurer_id']);
      const effectivePolicy =
        body.insurerPolicyNo !== undefined ? body.insurerPolicyNo : v0(existing['insurer_policy_no']);
      if (effectiveInsurer && !effectivePolicy) {
        throw ApiError.badRequest('An insurance policy number is required with an insurer.', [
          { path: 'insurerPolicyNo', message: 'Ask the patient for their insurance reference number.' },
        ]);
      }
      if (body.country !== undefined) values['country'] = nullable(body.country);
      if (body.emergencyContactName !== undefined) {
        values['emergency_contact_name'] = nullable(body.emergencyContactName);
      }
      if (body.emergencyContactPhone !== undefined) {
        values['emergency_contact_phone'] = nullable(body.emergencyContactPhone);
      }
      if (body.preferredLanguage !== undefined) values['preferred_language'] = body.preferredLanguage;
      if (body.whatsappOptIn !== undefined) {
        values['whatsapp_opt_in'] = bit(body.whatsappOptIn);
        // The consent timestamp is the audit record of *when* consent was given
        // or withdrawn, so it is written on both transitions rather than only on
        // opt-in.
        values['whatsapp_opt_in_at'] = body.whatsappOptIn ? now : null;
      }
      if (body.marketingOptIn !== undefined) values['marketing_opt_in'] = bit(body.marketingOptIn);
      if (body.chronicConditions !== undefined) values['chronic_conditions'] = jsonColumn(body.chronicConditions);
      if (body.allergies !== undefined) values['allergies'] = jsonColumn(body.allergies);
      if (body.currentMedications !== undefined) {
        values['current_medications'] = jsonColumn(body.currentMedications);
      }
      if (body.pastSurguries !== undefined) values['past_surgeries'] = jsonColumn(body.pastSurguries);
      if (body.familyHistory !== undefined) values['family_history'] = jsonColumn(body.familyHistory);
      if (body.notes !== undefined) values['notes'] = nullable(body.notes);
      if (body.tags !== undefined) values['tags'] = jsonColumn(body.tags);
      if (body.isActive !== undefined) values['is_active'] = bit(body.isActive);
      if (body.archivedAt !== undefined) values['archived_at'] = nullable(body.archivedAt);

      if (body.dateOfBirth) {
        const clinicTz = clinicTimezone(app.database, request.tenant.clinicId);
        values['age_years'] = ageFromDob(body.dateOfBirth, todayInTz(clinicTz));
      }
      if (body.heightCm !== undefined || body.weightKg !== undefined) {
        const height = (body.heightCm ?? toNumber(existing['height_cm'])) as number | null;
        const weight = (body.weightKg ?? toNumber(existing['weight_kg'])) as number | null;
        values['bmi'] = bmiFrom(height, weight);
      }

      // Keep the search blob consistent with whatever just changed.
      const merged = { ...existing, ...values };
      values['search_blob'] = buildSearchBlob({
        fullName: String(merged['full_name'] ?? ''),
        phone: String(merged['phone'] ?? ''),
        mrn: String(merged['mrn'] ?? ''),
        email: v0(merged['email']),
        nationalId: v0(merged['national_id']),
        city: v0(merged['city']),
      });

      db.update('patients', id, values);
      return toPatient(db.require<Row>('patients', id));
    }),
  );

  app.post(
    '/patients/:id/opt-out',
    { preHandler: requireCapability('patients:write') },
    handler(async (request) => {
      const { id } = parseParams(request, z.object({ id: idSchema }));
      const db = tenantOf(request);
      db.require('patients', id);
      const now = new Date().toISOString();
      db.update('patients', id, { whatsapp_opt_in: 0, whatsapp_opt_in_at: null, updated_at: now });
      return { ok: true, whatsappOptIn: false };
    }),
  );

  app.post(
    '/patients/:id/opt-in',
    { preHandler: requireCapability('patients:write') },
    handler(async (request) => {
      const { id } = parseParams(request, z.object({ id: idSchema }));
      const db = tenantOf(request);
      db.require('patients', id);
      const now = new Date().toISOString();
      db.update('patients', id, { whatsapp_opt_in: 1, whatsapp_opt_in_at: now, updated_at: now });
      return { ok: true, whatsappOptIn: true };
    }),
  );

  app.get(
    '/patients/:id/next-mrn',
    { preHandler: requireCapability('patients:read') },
    handler(async (request) => ({ mrn: nextMrn(tenantOf(request)) })),
  );
}

function v0(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
