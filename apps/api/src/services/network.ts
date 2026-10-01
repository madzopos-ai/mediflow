/**
 * Patient network: one identity per phone across every clinic on the app.
 *
 * Tenant isolation stays intact - every clinical table keeps its clinic_id
 * filter. The two network tables have NO clinic column and are reachable only
 * through this module, which enforces the single access rule the product
 * promises: a clinic sees a patient's shared record once the patient has a
 * link with it (booking, visit, or staff-confirmed import). Opening the
 * record writes an audit row, so every cross-clinic read is attributable to
 * a staff member and a moment.
 *
 * Phone numbers are the cross-clinic key because names collide and MRNs are
 * per-clinic. Lookup by phone reveals existence plus the basic profile only;
 * the clinical history requires opening the record, which creates the link.
 */

import { createId, normalizePhone, isValidE164 } from '@mediflow/shared';

import type { Db } from '../db/index.js';
import { ApiError } from '../http/errors.js';

export interface NetworkProfile {
  id: string;
  phone: string;
  firstName: string;
  lastName: string;
  fullName: string;
  dateOfBirth: string | null;
  sex: string;
  bloodGroup: string | null;
  address: string | null;
  city: string | null;
  country: string | null;
  emergencyContactName: string | null;
  emergencyContactPhone: string | null;
  chronicConditions: string[];
  allergies: string[];
  currentMedications: string[];
  verified: boolean;
  avatarUrl: string | null;
  createdAt: string;
}

export interface RegisterNetworkInput {
  phone: string;
  firstName: string;
  lastName: string;
  dateOfBirth?: string | null;
  sex?: string;
  bloodGroup?: string | null;
  address?: string | null;
  city?: string | null;
  country?: string | null;
  emergencyContactName?: string | null;
  emergencyContactPhone?: string | null;
  chronicConditions?: string[];
  allergies?: string[];
  currentMedications?: string[];
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

export function toNetworkProfile(row: Record<string, unknown>): NetworkProfile {
  return {
    id: String(row['id']),
    phone: String(row['phone']),
    firstName: String(row['first_name']),
    lastName: String(row['last_name']),
    fullName: String(row['full_name']),
    dateOfBirth: row['date_of_birth'] ? String(row['date_of_birth']) : null,
    sex: String(row['sex'] ?? 'unknown'),
    bloodGroup: row['blood_group'] ? String(row['blood_group']) : null,
    address: row['address'] ? String(row['address']) : null,
    city: row['city'] ? String(row['city']) : null,
    country: row['country'] ? String(row['country']) : null,
    emergencyContactName: row['emergency_contact_name'] ? String(row['emergency_contact_name']) : null,
    emergencyContactPhone: row['emergency_contact_phone'] ? String(row['emergency_contact_phone']) : null,
    chronicConditions: parseJsonStrings(row['chronic_conditions']),
    allergies: parseJsonStrings(row['allergies']),
    currentMedications: parseJsonStrings(row['current_medications']),
    verified: Number(row['verified'] ?? 0) === 1,
    avatarUrl: row['avatar_path'] ? `/network/avatars/${String(row['id'])}` : null,
    createdAt: String(row['created_at']),
  };
}

/** Canonical E.164, or null when the input cannot be one. */
export function canonicalPhone(raw: string, defaultDialCode = '966'): string | null {
  const phone = normalizePhone(raw, defaultDialCode);
  return phone && isValidE164(phone) ? phone : null;
}

export function findNetworkByPhone(db: Db, phone: string): NetworkProfile | null {
  const row = db
    .prepare('SELECT * FROM network_patients WHERE phone = ? LIMIT 1')
    .get(phone) as Record<string, unknown> | undefined;
  return row ? toNetworkProfile(row) : null;
}

export function getNetworkPatient(db: Db, id: string): NetworkProfile | null {
  const row = db.prepare('SELECT * FROM network_patients WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? toNetworkProfile(row) : null;
}

export function registerNetworkPatient(db: Db, input: RegisterNetworkInput): NetworkProfile {
  const phone = canonicalPhone(input.phone);
  if (!phone) throw ApiError.badRequest('Phone number is not a valid international number.');
  const existing = findNetworkByPhone(db, phone);
  // One phone, one record, forever. Re-registering returns the record rather
  // than forking a duplicate identity.
  if (existing) return existing;

  const now = new Date().toISOString();
  const id = createId('net');
  const fullName = `${input.firstName.trim()} ${input.lastName.trim()}`.trim();
  db.prepare(
    `INSERT INTO network_patients
      (id, phone, first_name, last_name, full_name, date_of_birth, sex, blood_group,
       address, city, country, emergency_contact_name, emergency_contact_phone,
       chronic_conditions, allergies, current_medications, verified, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
  ).run(
    id,
    phone,
    input.firstName.trim(),
    input.lastName.trim(),
    fullName,
    input.dateOfBirth ?? null,
    input.sex ?? 'unknown',
    input.bloodGroup ?? null,
    input.address ?? null,
    input.city ?? null,
    input.country ?? null,
    input.emergencyContactName ?? null,
    input.emergencyContactPhone ?? null,
    JSON.stringify(input.chronicConditions ?? []),
    JSON.stringify(input.allergies ?? []),
    JSON.stringify(input.currentMedications ?? []),
    now,
    now,
  );
  const created = getNetworkPatient(db, id);
  if (!created) throw new Error('Network registration did not persist.');
  return created;
}

export interface ClinicLink {
  id: string;
  clinicId: string;
  networkPatientId: string;
  localPatientId: string;
  createdAt: string;
}

export function getLink(db: Db, clinicId: string, networkPatientId: string): ClinicLink | null {
  const row = db
    .prepare('SELECT * FROM clinic_links WHERE clinic_id = ? AND network_patient_id = ? LIMIT 1')
    .get(clinicId, networkPatientId) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    id: String(row['id']),
    clinicId: String(row['clinic_id']),
    networkPatientId: String(row['network_patient_id']),
    localPatientId: String(row['local_patient_id']),
    createdAt: String(row['created_at']),
  };
}

export function getLinkByLocal(db: Db, clinicId: string, localPatientId: string): ClinicLink | null {
  const row = db
    .prepare('SELECT * FROM clinic_links WHERE clinic_id = ? AND local_patient_id = ? LIMIT 1')
    .get(clinicId, localPatientId) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    id: String(row['id']),
    clinicId: String(row['clinic_id']),
    networkPatientId: String(row['network_patient_id']),
    localPatientId: String(row['local_patient_id']),
    createdAt: String(row['created_at']),
  };
}

export function ensureLink(db: Db, clinicId: string, networkPatientId: string, localPatientId: string): ClinicLink {
  const existing = getLink(db, clinicId, networkPatientId);
  if (existing) return existing;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO clinic_links (id, clinic_id, network_patient_id, local_patient_id, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(clinic_id, network_patient_id) DO NOTHING`,
  ).run(createId('lnk'), clinicId, networkPatientId, localPatientId, now);
  const link = getLink(db, clinicId, networkPatientId);
  if (!link) throw new Error('Clinic link did not persist.');
  return link;
}

function audit(db: Db, clinicId: string, userId: string | null, action: string, entityId: string, detail: unknown): void {
  db.prepare(
    `INSERT INTO audit_log (id, clinic_id, user_id, action, entity_type, entity_id, detail, created_at)
     VALUES (?, ?, ?, ?, 'network_patient', ?, ?, ?)`,
  ).run(
    createId('aud'),
    clinicId,
    userId,
    action,
    entityId,
    JSON.stringify(detail ?? {}),
    new Date().toISOString(),
  );
}

export interface SharedClinicSection {
  clinicId: string;
  clinicName: string;
  vitals: { kind: string; value: number; unit: string; measuredAt: string }[];
  prescriptions: { id: string; items: { drug: string; dose?: string | null; frequency?: string | null }[]; status: string; createdAt: string }[];
  visits: { id: string; visitType: string; diagnosis: string | null; createdAt: string }[];
  requestedTests: { id: string; name: string; status: string; createdAt: string }[];
  documents: { id: string; title: string | null; fileName: string; kind: string; createdAt: string }[];
  appointments: { id: string; startsAt: string; status: string }[];
  reminders: { id: string; scheduledFor: string; template: string; appointmentStartsAt: string | null }[];
}

export interface SharedRecord {
  profile: NetworkProfile;
  clinics: SharedClinicSection[];
}

/**
 * Open the shared record for a clinic: link (creating it on first access),
 * audit the access, then aggregate every linked clinic's history with
 * provenance. Only non-sensitive metadata crosses clinics here - document
 * bytes stay behind each clinic's own file endpoint.
 */
export function openSharedRecord(
  db: Db,
  clinicId: string,
  networkPatientId: string,
  localPatientId: string | null,
  actorId: string | null,
): SharedRecord {
  const profile = getNetworkPatient(db, networkPatientId);
  if (!profile) throw ApiError.notFound('Patient is not registered on the network.');
  if (localPatientId) ensureLink(db, clinicId, networkPatientId, localPatientId);
  audit(db, clinicId, actorId, 'network.record.open', networkPatientId, { localPatientId });

  const links = db
    .prepare('SELECT * FROM clinic_links WHERE network_patient_id = ? ORDER BY created_at ASC')
    .all(networkPatientId) as Record<string, unknown>[];

  const sections: SharedClinicSection[] = [];
  for (const link of links) {
    const cid = String(link['clinic_id']);
    const lpid = String(link['local_patient_id']);
    const clinic = db.prepare('SELECT name FROM clinics WHERE id = ?').get(cid) as
      | { name: string }
      | undefined;
    const q = <T>(sql: string, params: (string | number)[]): T[] =>
      db.prepare(sql).all(cid, lpid, ...params) as T[];
    const vitals = q<{ kind: string; value: number; unit: string; measured_at: string }>(
      `SELECT kind, value, unit, measured_at FROM vital_readings
        WHERE clinic_id = ? AND patient_id = ? ORDER BY measured_at DESC LIMIT 50`,
      [],
    ).map((r) => ({ kind: r.kind, value: r.value, unit: r.unit, measuredAt: r.measured_at }));
    const prescriptions = q<{ id: string; items_json: string; status: string; created_at: string }>(
      `SELECT id, items_json, status, created_at FROM prescriptions
        WHERE clinic_id = ? AND patient_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 20`,
      [],
    ).map((r) => {
      let items: { drug: string; dose?: string | null; frequency?: string | null }[] = [];
      try {
        const parsed: unknown = JSON.parse(r.items_json);
        if (Array.isArray(parsed)) items = parsed as typeof items;
      } catch {
        items = [];
      }
      return { id: r.id, items, status: r.status, createdAt: r.created_at };
    });
    const visits = q<{ id: string; visit_type: string; diagnosis: string | null; created_at: string }>(
      `SELECT id, visit_type, diagnosis, created_at FROM visits
        WHERE clinic_id = ? AND patient_id = ? ORDER BY created_at DESC LIMIT 20`,
      [],
    ).map((r) => ({ id: r.id, visitType: r.visit_type, diagnosis: r.diagnosis, createdAt: r.created_at }));
    const requestedTests = q<{ id: string; name: string; status: string; created_at: string }>(
      `SELECT id, name, status, created_at FROM requested_tests
        WHERE clinic_id = ? AND patient_id = ? ORDER BY created_at DESC LIMIT 20`,
      [],
    ).map((r) => ({ id: r.id, name: r.name, status: r.status, createdAt: r.created_at }));
    const documents = q<{ id: string; title: string | null; file_name: string; kind: string; created_at: string }>(
      `SELECT id, title, file_name, kind, created_at FROM documents
        WHERE clinic_id = ? AND patient_id = ? ORDER BY created_at DESC LIMIT 20`,
      [],
    ).map((r) => ({ id: r.id, title: r.title, fileName: r.file_name, kind: r.kind, createdAt: r.created_at }));
    const appointments = q<{ id: string; starts_at: string; status: string }>(
      `SELECT id, starts_at, status FROM appointments
        WHERE clinic_id = ? AND patient_id = ? AND status NOT IN ('cancelled', 'no_show')
        ORDER BY starts_at DESC LIMIT 10`,
      [],
    ).map((r) => ({ id: r.id, startsAt: r.starts_at, status: r.status }));
    const apptStarts = new Map(appointments.map((a) => [a.id, a.startsAt]));
    const now = new Date().toISOString();
    const reminders = q<{ id: string; scheduled_for: string; template: string; appointment_id: string | null }>(
      `SELECT id, scheduled_for, template, appointment_id FROM reminders
        WHERE clinic_id = ? AND patient_id = ? AND status = 'scheduled' AND scheduled_for >= ?
        ORDER BY scheduled_for ASC LIMIT 20`,
      [now],
    ).map((r) => ({
      id: r.id,
      scheduledFor: r.scheduled_for,
      template: r.template,
      appointmentStartsAt: (r.appointment_id && apptStarts.get(r.appointment_id)) || null,
    }));
    sections.push({
      clinicId: cid,
      clinicName: clinic?.name ?? cid,
      vitals,
      prescriptions,
      visits,
      requestedTests,
      documents,
      appointments,
      reminders,
    });
  }

  return { profile, clinics: sections };
}
