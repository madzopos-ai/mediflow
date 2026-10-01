/**
 * Medical records: visits, clinical decision support, and document metadata.
 *
 * Decision-support output is always returned as a *draft*. The API never writes
 * a prescription or a diagnosis without a clinician confirming it, and the
 * response says so explicitly so a client cannot present the output as a
 * clinical decision.
 */

import type { FastifyInstance } from 'fastify';
import { createReadStream, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
import { z } from 'zod';
import {
  DOCUMENT_KINDS,
  checkDrugInteractions,
  createId,
  emptyClinicalContext,
  estimateEgfr,
  recommendLabGuidedDoses,
  recommendLifestyle,
  runRuleBasedDecisionSupport,
  sortInteractions,
  summariseDecisionSupport,
  type PatientClinicalContext,
} from '@mediflow/shared';

import {
  ApiError,
  handler,
  idSchema,
  paginationSchema,
  parseBody,
  parseQuery,
  parseParams
} from '../http/errors.js';
import { requireCapability } from '../auth/plugin.js';
import { tenantOf, userIdOf } from '../services/context.js';
import { nullable, toPatient, toVitalReading, type Row } from '../db/mappers.js';
import { syncPatientActivity } from '../services/activity.js';

const createVisitSchema = z.object({
  patientId: idSchema,
  appointmentId: idSchema.nullable().optional(),
  doctorId: idSchema.nullable().optional(),
  visitType: z.enum(['consultation', 'follow_up', 'procedure', 'teleconsult', 'review']).default('consultation'),
  chiefComplaint: z.string().trim().max(500).nullable().optional(),
  diagnosis: z.string().trim().max(500).nullable().optional(),
  icdCode: z.string().trim().max(20).nullable().optional(),
  plan: z.string().trim().max(8000).nullable().optional(),
  notes: z.string().trim().max(8000).nullable().optional(),
});

const uploadMetaSchema = z.object({
  patientId: idSchema,
  visitId: idSchema.nullable().optional(),
  kind: z.enum(DOCUMENT_KINDS),
  // Free-text name for test panels the enum never heard of ("HbA1c Q3").
  // kind stays for grouping; title is what the doctor reads.
  title: z.string().trim().min(1).max(160).nullable().optional(),
  fileName: z.string().trim().min(1).max(255),
  mimeType: z.string().trim().min(1).max(120),
  byteSize: z.number().int().min(1),
  checksum: z.string().trim().max(128).nullable().optional(),
});

/**
 * File bytes live under UPLOADS_DIR (default ./uploads relative to the
 * process working directory - the API npm scripts run with cwd=apps/api).
 * The stored filename is derived from the row id, never from user input, so
 * a hostile fileName cannot escape the directory.
 */
function uploadsDir(): string {
  const dir = resolve(process.env.UPLOADS_DIR ?? 'uploads');
  mkdirSync(dir, { recursive: true });
  return dir;
}

function storedName(id: string, fileName: string): string {
  const safe = basename(fileName).replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120) || 'file';
  return `${id}_${safe}`;
}

function resolveStoredFile(storagePath: string): string | null {
  const dir = uploadsDir();
  const absolute = resolve(dir, storagePath);
  if (absolute !== dir && !absolute.startsWith(dir + sep)) return null;
  if (!existsSync(absolute)) return null;
  return absolute;
}

export async function registerRecordRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/visits',
    { preHandler: requireCapability('clinical:read') },
    handler(async (request) => {
      const query = parseQuery(
        request,
        paginationSchema.extend({ patientId: idSchema.optional() }),
      );
      const tenant = tenantOf(request);
      const where = query.patientId ? 'patient_id = ?' : undefined;
      const params = query.patientId ? [query.patientId] : [];
      const rows = tenant.page<Row>('visits', {
        where,
        params,
        orderBy: 'created_at DESC',
        limit: query.limit,
        offset: query.offset,
      });
      return { items: rows, total: tenant.count('visits', where, params) };
    }),
  );

  app.post(
    '/visits',
    { preHandler: requireCapability('clinical:write') },
    handler(async (request, reply) => {
      const body = parseBody(request, createVisitSchema, 'visit');
      const tenant = tenantOf(request);
      tenant.require('patients', body.patientId);
      if (body.appointmentId) tenant.require('appointments', body.appointmentId);

      const now = new Date().toISOString();
      const id = createId('vst');
      tenant.insert('visits', {
        id,
        clinic_id: request.tenant.clinicId,
        patient_id: body.patientId,
        appointment_id: nullable(body.appointmentId),
        doctor_id: nullable(body.doctorId ?? userIdOf(request)),
        visit_type: body.visitType,
        chief_complaint: nullable(body.chiefComplaint),
        diagnosis: nullable(body.diagnosis),
        icd_code: nullable(body.icdCode),
        plan: nullable(body.plan),
        notes: nullable(body.notes),
        vitals_json: null,
        created_at: now,
        updated_at: now,
      });
      syncPatientActivity(tenant, body.patientId, now);
      return reply.status(201).send(tenant.require<Row>('visits', id));
    }),
  );

  /**
   * Rules-based decision support.
   *
   * Runs against the patient's own allergies, conditions, and medications, and
   * returns a summary a clinician can act on. The result is a draft: the API
   * never writes a prescription or a diagnosis from this, and says so in the
   * response so a client cannot present it as a clinical decision.
   */
  app.post(
    '/records/:patientId/decision-support',
    { preHandler: requireCapability('clinical:read') },
    handler(async (request) => {
      const { patientId } = parseParams(request, z.object({ patientId: idSchema }));
      const body = parseBody(
        request,
        z.object({
          diagnosis: z.string().trim().min(1).max(2000),
          medications: z.array(z.string().trim().max(200)).max(50).optional(),
          allergies: z.array(z.string().trim().max(120)).max(50).optional(),
          ageYears: z.number().int().min(0).max(130).optional(),
          sex: z.enum(['female', 'male', 'intersex', 'unknown']).optional(),
          isPregnant: z.boolean().optional(),
          candidateDrugIds: z.array(z.string().trim().max(64)).max(20).optional(),
        }),
        'decision support request',
      );
      const tenant = tenantOf(request);
      const patient = toPatient(tenant.require<Row>('patients', patientId));

      // Lab basis: the freshest reading per kind, straight from the chart.
      // A prediction that ignores the HbA1c sitting in the same record is a
      // prediction the doctor cannot trust, so the engine always sees them.
      const readingRows = tenant.page<Row>('vital_readings', {
        where: 'patient_id = ?',
        params: [patientId],
        orderBy: 'measured_at DESC',
        limit: 100,
        offset: 0,
      });
      const latest = new Map<string, Row>();
      for (const row of readingRows) {
        const kind = String(row['kind']);
        if (!latest.has(kind)) latest.set(kind, row);
      }
      const labNumber = (kind: string): number | null => {
        const value = latest.get(kind)?.['value'];
        return typeof value === 'number' ? value : null;
      };
      const monthAgo = new Date(Date.now() - 30 * 86_400_000).toISOString();
      const labMax = (kind: string): number | null => {
        let best: number | null = null;
        for (const row of readingRows) {
          if (String(row['kind']) !== kind) continue;
          if (String(row['measured_at']) < monthAgo) continue;
          const value = row['value'];
          if (typeof value === 'number' && (best === null || value > best)) best = value;
        }
        return best;
      };
      const labCreatinine = labNumber('creatinine');
      const labHba1c = labNumber('hba1c');

      const context: PatientClinicalContext = {
        ...emptyClinicalContext(),
        ageYears: body.ageYears ?? patient.ageYears,
        sex: body.sex ?? patient.sex,
        weightKg: patient.weightKg,
        heightCm: patient.heightCm,
        creatinine: labCreatinine,
        hba1c: labHba1c,
        maxSystolic: labMax('systolic_bp'),
        maxFastingGlucose: labMax('fasting_glucose'),
        allergies: body.allergies ?? patient.allergies,
        chronicConditions: patient.chronicConditions,
        currentMedications: body.medications ?? patient.currentMedications,
      };
      const egfr = estimateEgfr({
        ageYears: context.ageYears,
        sex: context.sex,
        weightKg: context.weightKg,
        creatinine: context.creatinine,
      });
      if (egfr !== null) context.egfr = egfr;

      const result = runRuleBasedDecisionSupport({
        diagnosis: body.diagnosis,
        context,
        currentMedications: body.medications ?? patient.currentMedications,
        knownConditions: patient.chronicConditions,
        candidateDrugIds: body.candidateDrugIds,
        // Pregnancy is passed at the top level so an explicit answer from the
        // caller overrides the context default; the shared engine resolves
        // `input.isPregnant ?? context.isPregnant`.
        isPregnant: body.isPregnant,
      });

      // Explicit doses from this patient's numbers: drug + dose + the values
      // behind it, so the doctor prescribes from the chart, not from memory.
      const currentMeds = body.medications ?? patient.currentMedications;
      const labGuided = recommendLabGuidedDoses({
        diagnosis: body.diagnosis,
        conditions: patient.chronicConditions,
        labs: {
          hba1c: context.hba1c,
          creatinine: context.creatinine,
          egfr: context.egfr,
          ldl: labNumber('ldl'),
          triglycerides: labNumber('triglycerides'),
          systolic: labMax('systolic_bp'),
          microalbumin: labNumber('microalbumin'),
          urineAcr: labNumber('urine_acr'),
          urea: labNumber('urea') ?? labNumber('blood_urea'),
        },
        biometrics: { ageYears: context.ageYears, sex: context.sex, weightKg: context.weightKg },
        currentMedications: currentMeds,
      });

      return {
        summary: summariseDecisionSupport(result),
        result,
        labGuided,
        lifestyle: recommendLifestyle(
          {
            diagnosis: body.diagnosis,
            conditions: patient.chronicConditions,
            labs: {
              hba1c: context.hba1c,
              systolic: labMax('systolic_bp'),
              ldl: labNumber('ldl'),
              triglycerides: labNumber('triglycerides'),
              microalbumin: labNumber('microalbumin'),
              urineAcr: labNumber('urine_acr'),
              creatinine: context.creatinine,
              urea: labNumber('urea') ?? labNumber('blood_urea'),
              egfr: context.egfr,
            },
            weightKg: context.weightKg,
            ageYears: context.ageYears,
          },
          'ar',
        ),
        // The exact lab values the prediction stood on, so the UI can show
        // its basis next to its conclusions.
        labsUsed: [...latest.values()].map((row) => ({
          kind: String(row['kind']),
          value: row['value'],
          unit: String(row['unit'] ?? ''),
          measuredAt: String(row['measured_at']),
        })),
        // Never let a client mistake this for a clinical decision.
        requiresClinicianReview: true,
        isPrescription: false,
      };
    }),
  );

  app.get(
    '/records/:patientId/interactions',
    { preHandler: requireCapability('clinical:read') },
    handler(async (request) => {
      const { patientId } = parseParams(request, z.object({ patientId: idSchema }));
      const query = parseQuery(
        request,
        z.object({ medications: z.string().trim().max(2000).optional() }),
      );
      const tenant = tenantOf(request);
      const patient = toPatient(tenant.require<Row>('patients', patientId));

      const list = (query.medications ?? patient.currentMedications.join(', '))
        .split(/[,\n;]/)
        .map((s) => s.trim())
        .filter(Boolean);
      if (list.length === 0) return { items: [], checked: [], summary: { severity: 'normal' } };

      const items = sortInteractions(checkDrugInteractions(list));
      return { items, checked: list };
    }),
  );

  app.get(
    '/documents',
    { preHandler: requireCapability('clinical:read') },
    handler(async (request) => {
      const query = parseQuery(
        request,
        paginationSchema.extend({
          patientId: idSchema.optional(),
          kind: z.enum(DOCUMENT_KINDS).optional(),
        }),
      );
      const tenant = tenantOf(request);
      const where: string[] = [];
      const params: string[] = [];
      if (query.patientId) {
        where.push('patient_id = ?');
        params.push(query.patientId);
      }
      if (query.kind) {
        where.push('kind = ?');
        params.push(query.kind);
      }
      const clause = where.length > 0 ? where.join(' AND ') : undefined;
      return {
        items: tenant.page<Row>('documents', {
          where: clause,
          params,
          orderBy: 'created_at DESC',
          limit: query.limit,
          offset: query.offset,
        }),
        total: tenant.count('documents', clause, params),
      };
    }),
  );

  /**
   * Record document metadata.
   *
   * Binary upload is intentionally out of scope for the API process: files go
   * to object storage through a presigned URL, and this endpoint only records
   * what was stored. A clinic server should not proxy 15 MB scans through Node.
   */
  app.post(
    '/documents',
    { preHandler: requireCapability('clinical:write') },
    handler(async (request, reply) => {
      const body = parseBody(request, uploadMetaSchema, 'document');
      const tenant = tenantOf(request);
      tenant.require('patients', body.patientId);
      if (body.visitId) tenant.require('visits', body.visitId);

      const now = new Date().toISOString();
      const id = createId('doc');
      tenant.insert('documents', {
        id,
        clinic_id: request.tenant.clinicId,
        patient_id: body.patientId,
        visit_id: nullable(body.visitId),
        kind: body.kind,
        title: nullable(body.title),
        file_name: body.fileName,
        mime_type: body.mimeType,
        byte_size: body.byteSize,
        checksum: nullable(body.checksum),
        storage_path: null,
        ocr_text: null,
        ocr_confidence: null,
        // 'pending' until a worker confirms the object exists.
        status: 'pending',
        uploaded_by: userIdOf(request),
        created_at: now,
        updated_at: now,
      });
      return reply.status(201).send(tenant.require<Row>('documents', id));
    }),
  );

  /**
   * Upload a document *with* its bytes (image, PDF, spreadsheet, ...).
   *
   * The file arrives as base64 inside JSON so no multipart plugin is needed;
   * 15 MB of bytes is the ceiling, matching MAX_UPLOAD_BYTES. Anything bigger
   * belongs in object storage, not in a clinic server request.
   */
  app.post(
    '/documents/upload',
    { preHandler: requireCapability('clinical:write') },
    handler(async (request, reply) => {
      const body = parseBody(
        request,
        z.object({
          patientId: idSchema,
          visitId: idSchema.nullable().optional(),
          kind: z.enum(DOCUMENT_KINDS),
          title: z.string().trim().min(1).max(160).nullable().optional(),
          fileName: z.string().trim().min(1).max(255),
          mimeType: z.string().trim().min(1).max(120),
          fileBase64: z.string().min(1).max(20_000_000),
        }),
        'document upload',
      );
      const tenant = tenantOf(request);
      tenant.require('patients', body.patientId);
      if (body.visitId) tenant.require('visits', body.visitId);

      // Buffer.from never throws on bad input - it silently drops characters -
      // so the shape is validated first.
      if (!/^[A-Za-z0-9+/=\r\n]+$/.test(body.fileBase64)) {
        throw ApiError.badRequest('File content is not valid base64.');
      }
      const bytes = Buffer.from(body.fileBase64, 'base64');
      if (bytes.length === 0 || bytes.length > 15 * 1024 * 1024) {
        throw ApiError.badRequest('File must be between 1 byte and 15 MB.');
      }

      const now = new Date().toISOString();
      const id = createId('doc');
      const name = storedName(id, body.fileName);
      writeFileSync(join(uploadsDir(), name), bytes);
      tenant.insert('documents', {
        id,
        clinic_id: request.tenant.clinicId,
        patient_id: body.patientId,
        visit_id: nullable(body.visitId),
        kind: body.kind,
        title: nullable(body.title),
        file_name: body.fileName,
        mime_type: body.mimeType,
        byte_size: bytes.length,
        checksum: null,
        storage_path: name,
        ocr_text: null,
        ocr_confidence: null,
        status: 'stored',
        uploaded_by: userIdOf(request),
        created_at: now,
        updated_at: now,
      });
      return reply.status(201).send(tenant.require<Row>('documents', id));
    }),
  );

  /**
   * Download (or inline-view) the stored bytes. Served with the recorded MIME
   * type and `inline` disposition so images and PDFs open in the browser while
   * anything else downloads.
   */
  app.get(
    '/documents/:id/file',
    { preHandler: requireCapability('clinical:read') },
    handler(async (request, reply) => {
      const { id } = parseParams(request, z.object({ id: idSchema }));
      const tenant = tenantOf(request);
      const document = tenant.get<Row>('documents', id);
      if (!document) throw ApiError.notFound('Document not found.');
      const storagePath = document['storage_path'] ? String(document['storage_path']) : null;
      const absolute = storagePath ? resolveStoredFile(storagePath) : null;
      if (!absolute) throw ApiError.notFound('No file stored for this document.');
      const fileName = String(document['file_name'] ?? 'file');
      return reply
        .header('content-type', String(document['mime_type'] ?? 'application/octet-stream'))
        .header('content-disposition', `inline; filename="${fileName.replace(/["\r\n]/g, '')}"`)
        .send(createReadStream(absolute));
    }),
  );

  /**
   * Delete a document and its stored bytes, if any. History is append-only
   * everywhere else in the system; documents are the exception because a scan
   * filed on the wrong patient must be removable. The audit log records who
   * deleted what (see services/activity), the bytes are unlinked.
   */
  app.delete(
    '/documents/:id',
    { preHandler: requireCapability('clinical:write') },
    handler(async (request) => {
      const { id } = parseParams(request, z.object({ id: idSchema }));
      const tenant = tenantOf(request);
      const document = tenant.get<Row>('documents', id);
      if (!document) throw ApiError.notFound('Document not found.');
      const storagePath = document['storage_path'] ? String(document['storage_path']) : null;
      const absolute = storagePath ? resolveStoredFile(storagePath) : null;
      tenant.remove('documents', id);
      if (absolute) {
        const { rmSync } = await import('node:fs');
        try {
          rmSync(absolute, { force: true });
        } catch {
          // The row is gone; a stranded file is reported, not fatal.
          throw ApiError.conflict('Record deleted, but the stored file could not be removed.');
        }
      }
      return { ok: true, id };
    }),
  );

  app.post(
    '/documents/:id/ocr',
    { preHandler: requireCapability('clinical:write') },
    handler(async (request) => {
      const { id } = parseParams(request, z.object({ id: idSchema }));
      const body = parseBody(
        request,
        z.object({
          text: z.string().max(200_000),
          confidence: z.number().min(0).max(1).nullable().optional(),
        }),
        'OCR result',
      );
      const tenant = tenantOf(request);
      const document = tenant.get<Row>('documents', id);
      if (!document) throw ApiError.notFound('Document not found.');

      tenant.update('documents', id, {
        ocr_text: body.text,
        ocr_confidence: body.confidence ?? null,
        status: 'processed',
        updated_at: new Date().toISOString(),
      });
      return { ok: true, id };
    }),
  );

  /** Latest readings for the vitals panel, most recent per kind. */
  app.get(
    '/records/:patientId/vitals-latest',
    { preHandler: requireCapability('clinical:read') },
    handler(async (request) => {
      const { patientId } = parseParams(request, z.object({ patientId: idSchema }));
      const tenant = tenantOf(request);
      tenant.require('patients', patientId);
      const rows = tenant.page<Row>('vital_readings', {
        where: 'patient_id = ?',
        params: [patientId],
        orderBy: 'measured_at DESC',
        // Bounded scan: the map below keeps one reading per kind, and a
        // long-lived chart would otherwise load every historical reading.
        limit: 500,
        offset: 0,
      });

      // One entry per kind, keeping the newest.
      const latest = new Map<string, ReturnType<typeof toVitalReading>>();
      for (const row of rows) {
        const reading = toVitalReading(row);
        if (!latest.has(reading.kind)) latest.set(reading.kind, reading);
      }
      return { items: [...latest.values()] };
    }),
  );
}
