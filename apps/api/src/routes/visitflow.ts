/**
 * Visit flow: requested tests and prescriptions.
 *
 * The diabetes-visit story, modelled directly:
 *   visit 1: the doctor orders panels -> requested_tests rows (status
 *     `requested`). The patient leaves with an appointment, not with paper.
 *   visit 2: results arrive by scan, PDF, or file and link back through
 *     document_id -> the row flips to `done`. Nothing ordered stays
 *     invisible, and nothing done floats without its order.
 *   treatment: the visit closes with a prescription - structured medication
 *     items plus diet and exercise - which is exactly what the patient app
 *     renders as a schedule. Free text would force the phone to parse; the
 *     structure here is the feature.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createId, estimateEgfr } from '@mediflow/shared';

import { ApiError, handler, idSchema, paginationSchema, parseBody, parseParams, parseQuery } from '../http/errors.js';
import { requireCapability } from '../auth/plugin.js';
import { tenantOf, userIdOf } from '../services/context.js';
import type { TenantHandle } from '../db/tenant.js';
import { nullable, type Row } from '../db/mappers.js';

const TEST_STATUSES = ['requested', 'done', 'cancelled'] as const;
const RX_STATUSES = ['active', 'completed', 'cancelled'] as const;

const testItemSchema = z.object({
  patientId: idSchema,
  visitId: idSchema.nullable().optional(),
  name: z.string().trim().min(2).max(160),
  notes: z.string().trim().max(2000).nullable().optional(),
});

const prescriptionItemSchema = z.object({
  drug: z.string().trim().min(1).max(200),
  dose: z.string().trim().max(120).nullable().optional(),
  frequency: z.string().trim().max(120).nullable().optional(),
  durationDays: z.number().int().min(1).max(3650).nullable().optional(),
  instructions: z.string().trim().max(1000).nullable().optional(),
});

const prescriptionSchema = z.object({
  patientId: idSchema,
  visitId: idSchema.nullable().optional(),
  items: z.array(prescriptionItemSchema).min(1).max(50),
  diet: z.array(z.string().trim().max(500)).max(30).default([]),
  exercise: z.array(z.string().trim().max(500)).max(30).default([]),
  notes: z.string().trim().max(4000).nullable().optional(),
});

function json<T>(value: T): string {
  return JSON.stringify(value);
}

function parseJsonArray(value: unknown): Record<string, unknown>[] {
  if (typeof value !== 'string') return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as Record<string, unknown>[]) : [];
  } catch {
    return [];
  }
}

function parseJsonStrings(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function toRequestedTest(row: Row): Record<string, unknown> {
  return {
    id: String(row['id']),
    patientId: String(row['patient_id']),
    visitId: row['visit_id'] ? String(row['visit_id']) : null,
    name: String(row['name']),
    status: String(row['status']),
    documentId: row['document_id'] ? String(row['document_id']) : null,
    notes: row['notes'] ? String(row['notes']) : null,
    createdAt: String(row['created_at']),
    updatedAt: String(row['updated_at']),
  };
}

export function toPrescription(row: Row): Record<string, unknown> {
  return {
    id: String(row['id']),
    patientId: String(row['patient_id']),
    visitId: row['visit_id'] ? String(row['visit_id']) : null,
    items: parseJsonArray(row['items_json']),
    diet: parseJsonStrings(row['diet_json']),
    exercise: parseJsonStrings(row['exercise_json']),
    labs: parseJsonObject(row['labs_json']),
    notes: row['notes'] ? String(row['notes']) : null,
    status: String(row['status']),
    createdAt: String(row['created_at']),
    updatedAt: String(row['updated_at']),
  };
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string') return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** The numbers on the chart at prescribing time: labs plus biometrics. */
function labsSnapshot(
  tenant: TenantHandle,
  patientId: string,
  ageYears: number | null,
  weightKg: number | null,
): Record<string, number> {
  const rows = tenant.page<Row>('vital_readings', {
    where: 'patient_id = ?',
    params: [patientId],
    orderBy: 'measured_at DESC',
    limit: 100,
    offset: 0,
  });
  const latest = new Map<string, number>();
  for (const row of rows) {
    const kind = String(row['kind']);
    if (!latest.has(kind) && typeof row['value'] === 'number') latest.set(kind, row['value']);
  }
  const snapshot: Record<string, number> = {};
  for (const kind of ['hba1c', 'creatinine', 'ldl', 'systolic_bp', 'fasting_glucose', 'urine_acr']) {
    const value = latest.get(kind);
    if (value !== undefined) snapshot[kind] = value;
  }
  if (ageYears !== null) snapshot['ageYears'] = ageYears;
  if (weightKg !== null) snapshot['weightKg'] = weightKg;
  const egfr = estimateEgfr({
    ageYears,
    sex: 'unknown',
    weightKg,
    creatinine: latest.get('creatinine') ?? null,
  });
  if (egfr !== null) snapshot['egfr'] = egfr;
  return snapshot;
}

export async function registerVisitFlowRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/requested-tests',
    { preHandler: requireCapability('clinical:write') },
    handler(async (request, reply) => {
      const body = parseBody(request, testItemSchema, 'requested test');
      const tenant = tenantOf(request);
      tenant.require('patients', body.patientId);
      if (body.visitId) tenant.require('visits', body.visitId);
      const now = new Date().toISOString();
      const id = createId('rt');
      tenant.insert('requested_tests', {
        id,
        clinic_id: request.tenant.clinicId,
        patient_id: body.patientId,
        visit_id: nullable(body.visitId),
        name: body.name,
        status: 'requested',
        document_id: null,
        notes: nullable(body.notes),
        created_by: userIdOf(request),
        created_at: now,
        updated_at: now,
      });
      return reply.status(201).send(toRequestedTest(tenant.require<Row>('requested_tests', id)));
    }),
  );

  app.get(
    '/requested-tests',
    { preHandler: requireCapability('clinical:read') },
    handler(async (request) => {
      const query = parseQuery(
        request,
        paginationSchema.extend({
          patientId: idSchema.optional(),
          status: z.enum(TEST_STATUSES).optional(),
        }),
      );
      const tenant = tenantOf(request);
      const where: string[] = [];
      const params: string[] = [];
      if (query.patientId) {
        where.push('patient_id = ?');
        params.push(query.patientId);
      }
      if (query.status) {
        where.push('status = ?');
        params.push(query.status);
      }
      const clause = where.length > 0 ? where.join(' AND ') : undefined;
      const rows = tenant.page<Row>('requested_tests', {
        where: clause,
        params,
        orderBy: 'created_at DESC',
        limit: query.limit,
        offset: query.offset,
      });
      return { items: rows.map(toRequestedTest), total: tenant.count('requested_tests', clause, params) };
    }),
  );

  app.patch(
    '/requested-tests/:id',
    { preHandler: requireCapability('clinical:write') },
    handler(async (request) => {
      const { id } = parseParams(request, z.object({ id: idSchema }));
      const body = parseBody(
        request,
        z.object({ status: z.enum(TEST_STATUSES), documentId: idSchema.nullable().optional() }),
        'requested test update',
      );
      const tenant = tenantOf(request);
      const existing = tenant.require<Row>('requested_tests', id);
      if (body.documentId) {
        // The result must belong to the same patient, or an order gets
        // "completed" by somebody else's lab report.
        const document = tenant.get<Row>('documents', body.documentId);
        if (!document || String(document['patient_id']) !== String(existing['patient_id'])) {
          throw ApiError.badRequest('The result document belongs to another patient.');
        }
      }
      tenant.update('requested_tests', id, {
        status: body.status,
        ...(body.documentId !== undefined ? { document_id: nullable(body.documentId) } : {}),
        updated_at: new Date().toISOString(),
      });
      return toRequestedTest(tenant.require<Row>('requested_tests', id));
    }),
  );

  app.post(
    '/prescriptions',
    { preHandler: requireCapability('clinical:write') },
    handler(async (request, reply) => {
      const body = parseBody(request, prescriptionSchema, 'prescription');
      const tenant = tenantOf(request);
      const patientRow = tenant.require<Row>('patients', body.patientId);
      if (body.visitId) tenant.require('visits', body.visitId);
      const now = new Date().toISOString();
      const id = createId('rx');
      tenant.insert('prescriptions', {
        id,
        clinic_id: request.tenant.clinicId,
        patient_id: body.patientId,
        visit_id: nullable(body.visitId),
        items_json: json(body.items),
        diet_json: json(body.diet),
        exercise_json: json(body.exercise),
        labs_json: json(
          labsSnapshot(
            tenant,
            body.patientId,
            typeof patientRow['age_years'] === 'number' ? (patientRow['age_years'] as number) : null,
            typeof patientRow['weight_kg'] === 'number' ? (patientRow['weight_kg'] as number) : null,
          ),
        ),
        notes: nullable(body.notes),
        status: 'active',
        created_by: userIdOf(request),
        created_at: now,
        updated_at: now,
      });
      return reply.status(201).send(toPrescription(tenant.require<Row>('prescriptions', id)));
    }),
  );

  app.get(
    '/prescriptions',
    { preHandler: requireCapability('clinical:read') },
    handler(async (request) => {
      const query = parseQuery(
        request,
        paginationSchema.extend({
          patientId: idSchema.optional(),
          status: z.enum(RX_STATUSES).optional(),
        }),
      );
      const tenant = tenantOf(request);
      const where: string[] = [];
      const params: string[] = [];
      if (query.patientId) {
        where.push('patient_id = ?');
        params.push(query.patientId);
      }
      if (query.status) {
        where.push('status = ?');
        params.push(query.status);
      }
      const clause = where.length > 0 ? where.join(' AND ') : undefined;
      const rows = tenant.page<Row>('prescriptions', {
        where: clause,
        params,
        orderBy: 'created_at DESC',
        limit: query.limit,
        offset: query.offset,
      });
      return { items: rows.map(toPrescription), total: tenant.count('prescriptions', clause, params) };
    }),
  );

  app.patch(
    '/prescriptions/:id',
    { preHandler: requireCapability('clinical:write') },
    handler(async (request) => {
      const { id } = parseParams(request, z.object({ id: idSchema }));
      const body = parseBody(request, z.object({ status: z.enum(RX_STATUSES) }), 'prescription update');
      const tenant = tenantOf(request);
      tenant.require<Row>('prescriptions', id);
      tenant.update('prescriptions', id, { status: body.status, updated_at: new Date().toISOString() });
      return toPrescription(tenant.require<Row>('prescriptions', id));
    }),
  );
}
