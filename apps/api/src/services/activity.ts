/**
 * Patient activity cache.
 *
 * `patients.next_appointment_at`, `last_visit_at`, and `last_vitals_at` are
 * denormalised so the patient list renders without a join or aggregate per
 * row. Anything that changes an appointment, a visit, or a reading must call
 * this, which is why it is a single function rather than a trigger per table.
 */

import type { TenantHandle } from '../db/tenant.js';
import { toAppointment, type Row } from '../db/mappers.js';

export function syncPatientActivity(
  tenant: TenantHandle,
  patientId: string,
  now = new Date().toISOString(),
): void {
  if (!patientId) return;
  if (!tenant.get('patients', patientId)) return;

  const active = tenant
    .all<Row>('appointments', 'patient_id = ?', [patientId])
    .map(toAppointment)
    .filter((a) => ['scheduled', 'confirmed', 'checked_in', 'in_progress'].includes(a.status))
    .map((a) => a.startsAt)
    .sort();

  const lastVisit = tenant
    .all<Row>('appointments', 'patient_id = ?', [patientId])
    .map(toAppointment)
    .filter((a) => a.completedAt !== null)
    .map((a) => a.completedAt as string)
    .sort()
    .pop();

  const lastVitals = tenant
    .all<Row>('vital_readings', 'patient_id = ?', [patientId])
    .map((r) => String(r['measured_at']))
    .sort()
    .pop();

  tenant.update('patients', patientId, {
    next_appointment_at: active[0] ?? null,
    last_visit_at: lastVisit ?? null,
    last_vitals_at: lastVitals ?? null,
    updated_at: now,
  });
}

/** Recompute a patient's outstanding balance from the payment ledger. */
export function syncPatientBalance(tenant: TenantHandle, patientId: string, now = new Date().toISOString()): number {
  // A charge raises what is owed; a payment or refund lowers it. Summing signed
  // amounts means the balance can never drift from the ledger it came from.
  const rows = tenant.withTenant<{ balance: number | null }>(
    `SELECT COALESCE(SUM(
       CASE direction
         WHEN 'charge' THEN amount_minor
         WHEN 'refund' THEN -amount_minor
         ELSE -amount_minor
       END), 0) AS balance
       FROM payments
      WHERE patient_id = ? AND clinic_id = ? AND status NOT IN ('failed', 'refunded')`,
    [patientId, tenant.clinicId],
  );

  const balance = Math.round(rows[0]?.balance ?? 0);
  tenant.update('patients', patientId, { balance_minor: balance, updated_at: now });
  return balance;
}
