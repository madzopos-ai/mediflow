/**
 * Safety-critical tests for the clinical decision support library.
 *
 * These are the tests that must never be allowed to fail silently: a false
 * negative here can mean a patient is prescribed a drug they are allergic to.
 */

import { describe, expect, it } from 'vitest';

import {
  checkAllergyConflicts,
  checkDrugInteractions,
  DRUG_CATALOG,
  evaluateParsed,
  findDrugsByName,
  getDrug,
  gradeTransaminases,
  interactionLibraryStats,
  matchProtocols,
  normaliseValueToCanonical,
  parseVitalsReply,
  protocolCoverage,
  resolveRegimen,
  runRuleBasedDecisionSupport,
  screenCandidateDrugs,
  substanceAdvisoriesForList,
  summariseDecisionSupport,
  TRANSAMINASE_ULN,
  validateInteractionLibrary,
  validateProtocolLibrary,
  type PatientClinicalContext,
} from '../src/index.js';

const ADULT: PatientClinicalContext = {
  ageYears: 55,
  sex: 'male',
  weightKg: 85,
  heightCm: 175,
  isPregnant: false,
  isBreastfeeding: false,
  creatinine: 0.9,
  egfr: 88,
  alt: 26,
  ast: 24,
  chronicConditions: [],
  currentMedications: [],
  allergies: [],
  maxSystolic: null,
  maxFastingGlucose: null,
  hba1c: null,
};

describe('protocol library integrity', () => {
  it('never references a drug or vital that is absent from the catalog', () => {
    expect(validateProtocolLibrary()).toEqual([]);
  });

  it('covers a meaningful number of conditions and specialties', () => {
    const coverage = protocolCoverage();
    expect(coverage.total).toBeGreaterThanOrEqual(20);
    expect(Object.keys(coverage.bySpecialty).length).toBeGreaterThanOrEqual(10);
  });

  it('drops regimen options whose drug is unknown instead of emitting dangling ids', () => {
    const resolved = resolveRegimen([
      { drugId: 'amoxicillin', rationale: 'real', role: 'first_line', conditionNotes: null },
      { drugId: 'definitely-not-a-drug', rationale: 'bogus', role: 'adjunct', conditionNotes: null },
    ]);
    expect(resolved.map((r) => r.drugId)).toEqual(['amoxicillin']);
  });

  it('matches a diagnosis written in plain clinical language', () => {
    const matches = matchProtocols('patient has high blood pressure', { limit: 3 });
    expect(matches[0]?.protocol.id).toBe('hypertension');
  });
});

describe('drug catalog', () => {
  it('resolves drugs by id and by name', () => {
    expect(getDrug('amoxicillin')?.genericName).toMatch(/Amoxicillin/i);
    expect(findDrugsByName('amox').length).toBeGreaterThan(0);
  });

  it('returns undefined for an unknown drug rather than throwing', () => {
    expect(getDrug('not-a-real-drug-xyz')).toBeUndefined();
  });

  it('has a unique id for every entry', () => {
    const ids = DRUG_CATALOG.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('decision support', () => {
  it('produces a reviewable regimen with no dangling drug ids', () => {
    const result = runRuleBasedDecisionSupport({
      diagnosis: 'essential hypertension',
      context: ADULT,
      specialty: 'cardiology',
    });
    expect(result.differential.length).toBeGreaterThan(0);
    expect(result.suggestedRegimen.length).toBeGreaterThan(0);
    for (const suggestion of result.suggestedRegimen) {
      expect(getDrug(suggestion.drugId)).toBeDefined();
    }
    expect(result.requiresClinicianReview).toBe(true);
    expect(result.disclaimer).toMatch(/decision aid only/i);
  });

  it('forces renal dose adjustment in stage 4 CKD', () => {
    const result = runRuleBasedDecisionSupport({
      diagnosis: 'hypertension',
      context: { ...ADULT, ageYears: 78, egfr: 22, creatinine: 2.4, chronicConditions: ['chronic kidney disease stage 4'] },
      specialty: 'cardiology',
    });
    expect(result.dosingAdjustments.length).toBeGreaterThan(0);
    expect(['warning', 'critical']).toContain(summariseDecisionSupport(result).severity);
  });

  it('does not escalate a healthy patient', () => {
    const result = runRuleBasedDecisionSupport({ diagnosis: 'hypertension', context: ADULT, specialty: 'cardiology' });
    expect(summariseDecisionSupport(result).severity).not.toBe('critical');
  });
});

describe('allergy safety', () => {
  const PENICILLIN_ALLERGY = { ...ADULT, allergies: ['penicillin'] };

  it('blocks a penicillin when a penicillin allergy is recorded', () => {
    const result = runRuleBasedDecisionSupport({
      diagnosis: 'acute dental pain',
      context: PENICILLIN_ALLERGY,
      specialty: 'dentistry',
    });
    expect(result.suggestedRegimen.some((s) => s.drugId === 'amoxicillin')).toBe(false);
    expect(result.allergyConflicts.some((c) => c.drugId === 'amoxicillin' && c.severity === 'contraindicated')).toBe(true);
    expect(result.contraindicationNotes.some((n) => /Excluded/i.test(n))).toBe(true);
    expect(summariseDecisionSupport(result).severity).toBe('critical');
  });

  it('offers the same drug when there is no allergy', () => {
    const result = runRuleBasedDecisionSupport({
      diagnosis: 'acute dental pain',
      context: ADULT,
      specialty: 'dentistry',
    });
    expect(result.suggestedRegimen.some((s) => s.drugId === 'amoxicillin')).toBe(true);
  });

  it('flags direct allergy and cross-reactivity for the whole penicillin family', () => {
    const conflicts = checkAllergyConflicts(['penicillin'], findDrugsByName('amoxicillin'));
    const ids = conflicts.filter((c) => c.severity === 'contraindicated').map((c) => c.drugId);
    expect(ids).toContain('amoxicillin');
    expect(ids).toContain('amoxicillin-clavulanate');
  });

  it('does not invent a conflict for an unrelated allergen', () => {
    const conflicts = checkAllergyConflicts(['penicillin'], findDrugsByName('paracetamol'));
    expect(conflicts.filter((c) => c.severity === 'contraindicated')).toEqual([]);
  });
});

describe('hepatic grading', () => {
  it('treats values up to the upper limit of normal as normal', () => {
    expect(gradeTransaminases(26)).toBe('normal');
    expect(gradeTransaminases(TRANSAMINASE_ULN)).toBe('normal');
  });

  it('grades by multiples of the upper limit of normal', () => {
    expect(gradeTransaminases(TRANSAMINASE_ULN * 1.5)).toBe('mild');
    expect(gradeTransaminases(TRANSAMINASE_ULN * 2.5)).toBe('moderate');
    expect(gradeTransaminases(TRANSAMINASE_ULN * 6)).toBe('severe');
  });

  it('treats unknown enzyme values as normal rather than abnormal', () => {
    expect(gradeTransaminases(null)).toBe('normal');
    expect(gradeTransaminases(undefined)).toBe('normal');
  });

  it('does not block paracetamol on normal transaminases', () => {
    const screened = screenCandidateDrugs(['paracetamol'], ADULT);
    expect(screened.approved.map((a) => a.drug.id)).toContain('paracetamol');
  });

  it('blocks paracetamol at 6x the upper limit of normal', () => {
    const screened = screenCandidateDrugs(['paracetamol'], { ...ADULT, ast: 260, alt: 240 });
    expect(screened.approved).toHaveLength(0);
    expect(screened.blocked).toHaveLength(1);
  });
});

describe('pregnancy and lactation safety', () => {
  const PREGNANT: PatientClinicalContext = { ...ADULT, sex: 'female', isPregnant: true };

  it('blocks teratogenic drugs in pregnancy', () => {
    const screened = screenCandidateDrugs(['warfarin', 'lisinopril'], PREGNANT);
    expect(screened.blocked.map((b) => b.drug.id).sort()).toEqual(['lisinopril', 'warfarin']);
  });

  it('keeps paracetamol available in pregnancy', () => {
    const screened = screenCandidateDrugs(['paracetamol'], PREGNANT);
    expect(screened.approved.map((a) => a.drug.id)).toContain('paracetamol');
  });
});

describe('drug interactions', () => {
  it('has no unreachable rules', () => {
    expect(validateInteractionLibrary()).toEqual([]);
    expect(interactionLibraryStats().deadRules).toBe(0);
  });

  it('detects the warfarin plus broad-spectrum antibiotic interaction', () => {
    const found = checkDrugInteractions(['warfarin', 'amoxicillin-clavulanate']);
    expect(found.length).toBeGreaterThan(0);
    expect(found.map((f) => `${f.drugA}|${f.drugB}`).join(' ')).toMatch(/[Ww]arfarin/);
  });

  it('returns nothing for a clean medication list', () => {
    expect(checkDrugInteractions(['paracetamol', 'vitamin-d3'])).toEqual([]);
  });

  it('fires the QT rule for ondansetron with a macrolide', () => {
    const found = checkDrugInteractions(['ondansetron', 'azithromycin']);
    expect(found.length).toBeGreaterThan(0);
    expect(found[0]!.severity).toBe('major');
    expect(found[0]!.clinicalEffect).toMatch(/torsades/i);
  });

  it('fires the theophylline rules for both macrolides and fluoroquinolones', () => {
    expect(checkDrugInteractions(['theophylline', 'ciprofloxacin'])[0]?.severity).toBe('major');
    expect(checkDrugInteractions(['theophylline', 'azithromycin'])[0]?.severity).toBe('major');
  });

  it('fires the statin and fibrate rule', () => {
    expect(checkDrugInteractions(['atorvastatin', 'fenofibrate'])[0]?.severity).toBe('moderate');
  });

  it('fires the SSRI and tramadol serotonin rule', () => {
    expect(checkDrugInteractions(['sertraline', 'tramadol'])[0]?.severity).toBe('major');
  });

  it('fires the iron and antacid chelation rule', () => {
    expect(checkDrugInteractions(['ferrous-sulfate', 'aluminium-hydroxide'])[0]?.severity).toBe('minor');
  });

  it('reports a pair once even when several rules match it', () => {
    const found = checkDrugInteractions(['ondansetron', 'azithromycin']);
    expect(found).toHaveLength(1);
  });

  it('keeps findings for genuinely different pairs in a list', () => {
    const found = checkDrugInteractions(['warfarin', 'ibuprofen', 'aspirin']);
    expect(found).toHaveLength(2);
  });

  it('blocks a candidate that has a major interaction with current medication', () => {
    const screened = screenCandidateDrugs(['azithromycin'], {
      ...ADULT,
      currentMedications: ['ondansetron'],
    });
    expect(screened.blocked.length).toBeGreaterThan(0);
  });

  it('surfaces alcohol and grapefruit as substance advisories, not drug pairs', () => {
    const advisories = substanceAdvisoriesForList(['metronidazole', 'atorvastatin']);
    expect(advisories.map((a) => a.substance)).toEqual(
      expect.arrayContaining([expect.stringContaining('Alcohol'), expect.stringContaining('Grapefruit')]),
    );
    expect(advisories[0]!.severity).toBe('contraindicated');
    expect(advisories[0]!.washoutAfterLastDoseHours).toBe(48);
  });
});

describe('vital reply parsing', () => {
  it('parses an Arabic blood pressure reply as a pair', () => {
    const parsed = parseVitalsReply('ضغط ١٣٠/٨٥ ونبض ٧٢', { expectedKind: 'systolic_bp' });
    const bp = parsed.readings.find((r) => r.kind === 'systolic_bp');
    expect(bp?.value).toBe(130);
    expect(bp?.secondaryValue).toBe(85);
    expect(parsed.readings.some((r) => r.kind === 'pulse' && r.value === 72)).toBe(true);
  });

  it('parses an English blood pressure reply as a pair', () => {
    const parsed = parseVitalsReply('120/80 and pulse 72', { expectedKind: 'systolic_bp' });
    const bp = parsed.readings.find((r) => r.kind === 'systolic_bp');
    expect(bp?.value).toBe(120);
    expect(bp?.secondaryValue).toBe(80);
  });

  it('evaluates both halves of a blood pressure pair', () => {
    const parsed = parseVitalsReply('180/120', { expectedKind: 'systolic_bp' });
    const kinds = evaluateParsed(parsed).map((e) => e.kind);
    expect(kinds).toContain('systolic_bp');
    expect(kinds).toContain('diastolic_bp');
  });

  it('reads a bare glucose number as mmol/L rather than mg/dL', () => {
    const parsed = parseVitalsReply('8.5', { expectedKind: 'fasting_glucose' });
    const reading = parsed.readings.find((r) => r.kind === 'fasting_glucose');
    expect(reading?.value).toBe(153);
  });

  it('leaves an explicit mg/dL value unconverted', () => {
    const parsed = parseVitalsReply('glucose 153 mg/dl', { expectedKind: 'fasting_glucose' });
    const reading = parsed.readings.find((r) => r.kind === 'fasting_glucose');
    expect(reading?.value).toBe(153);
  });

  it('converts an explicitly stated mmol/L value', () => {
    expect(normaliseValueToCanonical('fasting_glucose', 8.5, 'mmol/l', '')).toBeCloseTo(153.15, 1);
  });

  it('does not convert a value that is already plausible in the canonical unit', () => {
    expect(normaliseValueToCanonical('fasting_glucose', 153, 'unknown', '')).toBe(153);
  });

  it('converts Fahrenheit to Celsius', () => {
    expect(normaliseValueToCanonical('temperature', 100.4, 'unknown', '100.4 F')).toBeCloseTo(38, 0);
  });

  it('returns no readings for an unparseable message', () => {
    const parsed = parseVitalsReply('thank you doctor');
    expect(parsed.readings).toEqual([]);
  });
});
