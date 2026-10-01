/**
 * Patient business logic.
 *
 * Kept separate from the routes so the same rules apply no matter whether a
 * patient is created by staff, by an inbound WhatsApp message, or by a public
 * booking - all three paths call `createPatient`.
 */

import {
  ageFromDob,
  bmiFrom,
  createId,
  formatMrn,
  isValidE164,
  normalizePhone,
  slugify,
  type Patient,
  type Sex,
  type Source,
} from '@mediflow/shared';

import type { TenantHandle } from '../db/tenant.js';
import { bit, jsonColumn, nullable, toPatient, type Row } from '../db/mappers.js';
import { ApiError } from '../http/errors.js';

export interface CreatePatientInput {
  firstName: string;
  lastName: string;
  fullName?: string;
  phone: string;
  whatsappNumber?: string | null;
  email?: string | null;
  nationalId?: string | null;
  dateOfBirth?: string | null;
  sex?: Sex;
  bloodGroup?: string | null;
  heightCm?: number | null;
  weightKg?: number | null;
  address?: string | null;
  city?: string | null;
  country?: string | null;
  emergencyContactName?: string | null;
  emergencyContactPhone?: string | null;
  preferredLanguage?: 'en' | 'ar';
  whatsappOptIn?: boolean;
  marketingOptIn?: boolean;
  chronicConditions?: string[];
  allergies?: string[];
  currentMedications?: string[];
  pastSurguries?: string[];
  familyHistory?: string[];
  notes?: string | null;
  tags?: string[];
  insurerId?: string | null;
  insurerPolicyNo?: string | null;
  source?: Source;
  createdBy?: string | null;
}

/**
 * Next MRN for the clinic.
 *
 * Derived from the highest numeric MRN suffix in the clinic, falling back to
 * the row count for legacy data that does not follow the `MRN-000123` shape.
 * Two concurrent creations can still compute the same number, so
 * `createPatient` retries on the UNIQUE constraint rather than trusting the
 * read to stay unique. Using MAX instead of COUNT also avoids re-issuing a
 * number freed by a deleted or merged patient row.
 */
export function nextMrn(db: TenantHandle): string {
  const rows = db.withTenant<{ maxSeq: number | null }>(
    'SELECT MAX(CAST(SUBSTR(mrn, 5) AS INTEGER)) AS maxSeq FROM patients WHERE clinic_id = ?',
    [db.clinicId],
  );
  const max = rows[0]?.maxSeq;
  const seq = (typeof max === 'number' && Number.isFinite(max) ? max : db.count('patients')) + 1;
  return formatMrn('MRN', seq);
}

/**
 * The denormalised `search_blob` keeps list search to a single LIKE instead of
 * seven ORs across typed columns.
 */
export function buildSearchBlob(input: {
  fullName: string;
  phone: string;
  mrn: string;
  email?: string | null;
  nationalId?: string | null;
  city?: string | null;
  tags?: string[];
}): string {
  return [
    input.fullName,
    input.phone,
    input.mrn,
    input.email ?? '',
    input.nationalId ?? '',
    input.city ?? '',
    ...(input.tags ?? []),
  ]
    .join(' ')
    .toLowerCase()
    .trim();
}

export interface NormalizedPhone {
  phone: string;
  whatsappNumber: string | null;
}

/**
 * Normalise a phone to E.164.
 *
 * A clinic that stores a national-format number will silently fail to message
 * the patient, so the stored form is always E.164 and the original is only
 * kept in the search blob.
 */
export function normalizePatientPhone(
  raw: string,
  defaultDialCode: string,
  whatsappRaw?: string | null,
): NormalizedPhone {
  const phone = normalizePhone(raw, defaultDialCode);
  if (!phone || !isValidE164(phone)) {
    throw ApiError.badRequest('Phone number is not a valid international number.', [
      { path: 'phone', message: 'Use international format, e.g. +966512345678.' },
    ]);
  }
  const whatsapp = whatsappRaw ? normalizePhone(whatsappRaw, defaultDialCode) : phone;
  return { phone, whatsappNumber: whatsapp && isValidE164(whatsapp) ? whatsapp : null };
}

export function createPatient(
  db: TenantHandle,
  clinicId: string,
  input: CreatePatientInput,
  defaultDialCode = '966',
): Patient {
  const now = new Date().toISOString();
  const id = createId('pat');
  const fullName = input.fullName?.trim() || `${input.firstName} ${input.lastName}`.trim();
  const { phone, whatsappNumber } = normalizePatientPhone(
    input.phone,
    defaultDialCode,
    input.whatsappNumber ?? null,
  );

  const bmi = bmiFrom(input.heightCm ?? null, input.weightKg ?? null);
  const tags = input.tags ?? [];
  // Age at creation, so the chart is complete from the first row. Staff
  // creation always carries a date of birth; paths without one keep NULL.
  const ageYears = input.dateOfBirth
    ? (ageFromDob(input.dateOfBirth, now.slice(0, 10)) ?? null)
    : null;

  // Retry on a UNIQUE collision rather than trusting the count-based MRN to be
  // race-free. Five attempts is far more than concurrent staff can generate.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const mrn = nextMrn(db);
    const searchBlob = buildSearchBlob({
      fullName,
      phone,
      mrn,
      email: input.email,
      nationalId: input.nationalId,
      city: input.city,
      tags,
    });

    try {
      db.insert('patients', {
        id,
        clinic_id: clinicId,
        mrn,
        first_name: input.firstName,
        last_name: input.lastName,
        full_name: fullName,
        phone,
        whatsapp_number: whatsappNumber,
        email: nullable(input.email),
        national_id: nullable(input.nationalId),
        date_of_birth: nullable(input.dateOfBirth),
        age_years: ageYears,
        sex: input.sex ?? 'unknown',
        blood_group: nullable(input.bloodGroup),
        height_cm: input.heightCm ?? null,
        weight_kg: input.weightKg ?? null,
        bmi,
        address: nullable(input.address),
        city: nullable(input.city),
        country: nullable(input.country),
        emergency_contact_name: nullable(input.emergencyContactName),
        emergency_contact_phone: nullable(input.emergencyContactPhone),
        preferred_language: input.preferredLanguage ?? 'en',
        whatsapp_opt_in: bit(input.whatsappOptIn ?? true),
        whatsapp_opt_in_at: input.whatsappOptIn === false ? null : now,
        whatsapp_verified_at: null,
        marketing_opt_in: bit(input.marketingOptIn ?? false),
        chronic_conditions: jsonColumn(input.chronicConditions ?? []),
        allergies: jsonColumn(input.allergies ?? []),
        current_medications: jsonColumn(input.currentMedications ?? []),
        past_surgeries: jsonColumn(input.pastSurguries ?? []),
        family_history: jsonColumn(input.familyHistory ?? []),
        notes: nullable(input.notes),
        search_blob: searchBlob,
        tags: jsonColumn(tags),
        insurer_id: nullable(input.insurerId),
        insurer_policy_no: nullable(input.insurerPolicyNo),
        source: input.source ?? 'staff',
        is_active: 1,
        archived_at: null,
        last_visit_at: null,
        next_appointment_at: null,
        balance_minor: 0,
        last_vitals_at: null,
        created_by: nullable(input.createdBy),
        created_at: now,
        updated_at: now,
      });
      break;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const isUniqueViolation = message.includes('UNIQUE constraint failed: patients.clinic_id, patients.mrn');
      if (!isUniqueViolation || attempt === 4) throw error;
    }
  }

  const row = db.get<Row>('patients', id);
  if (!row) throw new Error('Patient insert did not persist.');
  return toPatient(row);
}

/** Find a patient by exact phone, used when an inbound message arrives. */
export function findByPhone(db: TenantHandle, phone: string): Patient | null {
  const row = db.find<Row>('patients', 'phone = ?', [phone]);
  return row ? toPatient(row) : null;
}

/**
 * Refresh the cached `next_appointment_at` and `last_visit_at` on a patient.
 * Called after any appointment state change so the patient list does not need
 * a join per row.
 */
export function refreshPatientActivity(
  db: TenantHandle,
  patientId: string,
  appointments: readonly { startsAt: string; status: string; completedAt: string | null }[],
  now = new Date().toISOString(),
): void {
  const active = appointments
    .filter((a) => ['scheduled', 'confirmed', 'checked_in', 'in_progress'].includes(a.status))
    .map((a) => a.startsAt)
    .sort();
  const lastVisit = appointments
    .filter((a) => a.completedAt !== null)
    .map((a) => a.completedAt as string)
    .sort()
    .pop();

  db.update('patients', patientId, {
    next_appointment_at: active[0] ?? null,
    last_visit_at: lastVisit ?? null,
    updated_at: now,
  });
}

export function patientSlug(fullName: string): string {
  return slugify(fullName, 60);
}
