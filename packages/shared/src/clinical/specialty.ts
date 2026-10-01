/**
 * Specialty scoping: what a specialist sees first.
 *
 * An orthopedist opening the drug picker should meet orthopedic drugs, not
 * page through antidiabetics - and a nephrologist's lab panel leads with
 * creatinine, not HbA1c. The drug catalog already carries specialties per
 * drug; this module adds the lab side and one helper per side.
 */

import { DRUG_CATALOG, type Drug } from './drugs.js';
import type { Specialty } from '../domain/enums.js';
import type { VitalKind } from '../domain/enums.js';

/** Drugs whose catalog entry names this specialty, alphabetical. */
export function drugsForSpecialty(specialty: Specialty): Drug[] {
  return DRUG_CATALOG.filter((d) => d.specialties.includes(specialty)).sort((a, b) =>
    a.genericName.localeCompare(b.genericName),
  );
}

/** Lab kinds a specialty orders most, in panel order. Everything else stays
 *  available below - scoping orders the list, it never hides a test. */
export const SPECIALTY_LAB_KINDS: Record<Specialty, readonly VitalKind[]> = {
  general_medicine: ['fasting_glucose', 'hba1c', 'systolic_bp', 'diastolic_bp', 'pulse', 'weight'],
  endocrinology: ['fasting_glucose', 'hba1c', 'weight', 'creatinine', 'ldl', 'hdl', 'triglycerides'],
  cardiology: ['systolic_bp', 'diastolic_bp', 'pulse', 'ldl', 'hdl', 'triglycerides', 'spo2'],
  dentistry: [],
  pediatrics: ['weight', 'height', 'temperature', 'spo2', 'pulse'],
  dermatology: [],
  gynecology: ['hemoglobin', 'systolic_bp', 'diastolic_bp', 'weight'],
  orthopedics: ['weight', 'creatinine', 'hemoglobin', 'crp', 'esr'],
  ophthalmology: ['fasting_glucose', 'hba1c', 'systolic_bp', 'diastolic_bp'],
  psychiatry: ['weight', 'fasting_glucose', 'triglycerides'],
  pulmonology: ['spo2', 'respiratory_rate', 'pulse', 'temperature'],
  gastroenterology: ['hemoglobin', 'creatinine', 'weight'],
  neurology: ['systolic_bp', 'diastolic_bp', 'pulse', 'fasting_glucose'],
  nephrology: ['creatinine', 'urea', 'microalbumin', 'urine_acr', 'hemoglobin', 'serum_potassium', 'systolic_bp'],
  rheumatology: ['crp', 'esr', 'hemoglobin', 'creatinine'],
  hematology: ['hemoglobin', 'wbc', 'rbc', 'hematocrit', 'platelets', 'mcv', 'mch', 'esr'],
  oncology: ['wbc', 'hemoglobin', 'platelets', 'creatinine', 'weight'],
  urology: ['creatinine', 'urea', 'urine_acr', 'microalbumin'],
  ent: [],
  nutrition: ['weight', 'bmi', 'fasting_glucose', 'hba1c', 'triglycerides', 'ldl', 'hdl'],
  physiotherapy: ['weight', 'pulse', 'systolic_bp'],
  other: [],
};

/** Specialty-first kind order: their panel first, everything else after. */
export function orderKindsForSpecialty(kinds: readonly VitalKind[], specialty: Specialty | null): VitalKind[] {
  if (!specialty) return [...kinds];
  const first = SPECIALTY_LAB_KINDS[specialty] ?? [];
  const priority = new Set(first);
  return [...first.filter((k) => kinds.includes(k)), ...kinds.filter((k) => !priority.has(k))];
}
