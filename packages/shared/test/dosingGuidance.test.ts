/**
 * Lab-guided dosing: the numbers in, the dose out, every reason cited.
 *
 * Each case pins the exact behaviour the doctor relies on: tiers escalate,
 * kidneys cap, existing therapy suppresses duplicates, and withholding is an
 * explicit recommendation rather than silence.
 */

import { describe, expect, it } from 'vitest';

import { recommendLabGuidedDoses, type DoseInput } from '../src/clinical/dosingGuidance.js';

function base(overrides: Partial<DoseInput> = {}): DoseInput {
  return {
    diagnosis: 'Type 2 diabetes',
    conditions: [],
    labs: { hba1c: null, creatinine: null, egfr: null, ldl: null, triglycerides: null, systolic: null, microalbumin: null, urineAcr: null, urea: null },
    biometrics: { ageYears: 52, sex: 'male', weightKg: 82 },
    currentMedications: [],
    ...overrides,
  };
}

describe('recommendLabGuidedDoses', () => {
  it('intensifies metformin at HbA1c 9.1 and cites the value', () => {
    const [rec] = recommendLabGuidedDoses(base({ labs: { ...base().labs, hba1c: 9.1 } }));
    expect(rec?.drug).toBe('Metformin');
    expect(rec?.dose).toBe('1000mg');
    expect(rec?.frequency).toBe('twice daily');
    expect(rec?.reasons.join(' ')).toContain('9.1');
  });

  it('caps metformin when eGFR is 30-45', () => {
    const [rec] = recommendLabGuidedDoses(base({ labs: { ...base().labs, hba1c: 9.4, egfr: 42 } }));
    expect(rec?.frequency).toBe('once daily');
    expect(rec?.reasons.join(' ')).toContain('42');
  });

  it('withholds metformin below eGFR 30 instead of dosing', () => {
    const [rec] = recommendLabGuidedDoses(base({ labs: { ...base().labs, hba1c: 10, egfr: 25 } }));
    expect(rec?.contraindicated).toBe(true);
    expect(rec?.reasons.join(' ')).toContain('25');
  });

  it('starts 500mg twice daily in the 7-9 band', () => {
    const [rec] = recommendLabGuidedDoses(base({ labs: { ...base().labs, hba1c: 7.8 } }));
    expect(rec?.dose).toBe('500mg');
  });

  it('adds a statin for LDL 190+ and for diabetic age band', () => {
    const high = recommendLabGuidedDoses(
      base({ diagnosis: 'Checkup', labs: { ...base().labs, ldl: 195 } }),
    );
    expect(high.some((r) => r.drug === 'Atorvastatin' && r.dose === '20mg')).toBe(true);

    const band = recommendLabGuidedDoses(base({ labs: { ...base().labs, ldl: 140 } }));
    expect(band.some((r) => r.drug === 'Atorvastatin')).toBe(true);
  });

  it('recommends ACE inhibition on albuminuria and skips duplicates', () => {
    const recs = recommendLabGuidedDoses(base({ labs: { ...base().labs, urineAcr: 472 } }));
    const ace = recs.find((r) => r.drug === 'Lisinopril');
    expect(ace?.dose).toBe('10mg');
    expect(ace?.reasons.join(' ')).toContain('472');

    const dupes = recommendLabGuidedDoses(
      base({ labs: { ...base().labs, urineAcr: 472 }, currentMedications: ['Lisinopril 10mg'] }),
    );
    expect(dupes.some((r) => r.drug === 'Lisinopril')).toBe(false);
  });

  it('stays silent for a non-diabetic with clean labs', () => {
    expect(
      recommendLabGuidedDoses(
        base({ diagnosis: 'Common cold', labs: { ...base().labs, ldl: 100 } }),
      ),
    ).toEqual([]);
  });

  it('addresses high triglycerides even without LDL', () => {
    const recs = recommendLabGuidedDoses(
      base({ diagnosis: 'Checkup', labs: { ...base().labs, triglycerides: 250 } }),
    );
    const statin = recs.find((r) => r.drug === 'Atorvastatin');
    expect(statin?.reasons.join(' ')).toContain('250');
  });
  it('never stays silent on HbA1c 9.1 + microalbuminuria + high urea', () => {
    const recs = recommendLabGuidedDoses(
      base({
        diagnosis: 'Type 2 diabetes',
        labs: { ...base().labs, hba1c: 9.1, microalbumin: 243, urea: 189, creatinine: 0.743 },
      }),
    );
    const met = recs.find((r) => r.drug === 'Metformin');
    expect(met?.contraindicated).toBe(false);
    expect(met?.reasons.join(' ')).toContain('9.1');
    const ace = recs.find((r) => r.drug === 'Lisinopril');
    expect(ace?.reasons.join(' ')).toContain('243');
    expect(ace?.reasons.join(' ')).toContain('189');
  });

  it('adds SGLT2i dual therapy at HbA1c 9+ with follow-up and safety', () => {
    const recs = recommendLabGuidedDoses(
      base({ labs: { ...base().labs, hba1c: 9.5, microalbumin: 80 } }),
    );
    const sglt2 = recs.find((r) => r.drug === 'Empagliflozin');
    expect(sglt2?.dose).toBe('10mg');
    expect(sglt2?.reasons.join(' ')).toContain('dual therapy');
    expect(sglt2?.reasons.join(' ')).toContain('3 months');
    expect(sglt2?.reasons.join(' ')).toContain('renal protection');
    // Triple backbone emerges: metformin + SGLT2i + ACEi.
    expect(recs.some((r) => r.drug === 'Metformin')).toBe(true);
    expect(recs.some((r) => r.drug === 'Lisinopril')).toBe(true);
  });

  it('withholds SGLT2i below eGFR 20 and skips it when already prescribed', () => {
    const low = recommendLabGuidedDoses(base({ labs: { ...base().labs, hba1c: 9.5, egfr: 18 } }));
    const held = low.find((r) => r.drug === 'Empagliflozin');
    expect(held?.contraindicated).toBe(true);

    const dupes = recommendLabGuidedDoses(
      base({ labs: { ...base().labs, hba1c: 9.5 }, currentMedications: ['Empagliflozin 10mg'] }),
    );
    expect(dupes.some((r) => r.drug === 'Empagliflozin')).toBe(false);
  });
});
