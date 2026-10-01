/**
 * Lifestyle guidance: targets, diet and exercise drafted from the labs.
 * Educational content - the clinician hands it to the patient after review.
 */

import { describe, expect, it } from 'vitest';

import { recommendLifestyle } from '../src/clinical/lifestyle.js';

describe('recommendLifestyle', () => {
  it('sets HbA1c and weight targets for a diabetic patient', () => {
    const plan = recommendLifestyle({
      diagnosis: 'Type 2 diabetes',
      conditions: [],
      labs: {
        hba1c: 9.1,
        systolic: null,
        ldl: null,
        triglycerides: null,
        microalbumin: null,
        urineAcr: null,
        creatinine: null,
        urea: null,
        egfr: null,
      },
      weightKg: 82,
      ageYears: 50,
    });
    expect(plan.targets.join(' ')).toContain('7.0');
    expect(plan.targets.join(' ')).toContain('-5%');
    expect(plan.diet.join(' ')).toMatch(/carbohydrate/i);
    expect(plan.exercise.join(' ')).toMatch(/30 minutes/);
  });

  it('adds renal-safe diet on albuminuria with high urea', () => {
    const plan = recommendLifestyle({
      diagnosis: 'Diabetes with nephropathy',
      conditions: [],
      labs: {
        hba1c: 8.2,
        systolic: null,
        ldl: null,
        triglycerides: null,
        microalbumin: 243,
        urineAcr: null,
        creatinine: 0.743,
        urea: 189,
        egfr: null,
      },
      weightKg: null,
      ageYears: 60,
    });
    expect(plan.diet.join(' ')).toMatch(/sodium/i);
    expect(plan.diet.join(' ')).toMatch(/protein/i);
    expect(plan.targets.join(' ')).toMatch(/creatinine|albuminuria/i);
  });

  it('keeps gentle exercise guidance for older patients', () => {    const plan = recommendLifestyle({
      diagnosis: 'Checkup',
      conditions: [],
      labs: {
        hba1c: null,
        systolic: 150,
        ldl: null,
        triglycerides: null,
        microalbumin: null,
        urineAcr: null,
        creatinine: null,
        urea: null,
        egfr: null,
      },
      weightKg: null,
      ageYears: 70,
    });
    expect(plan.targets.join(' ')).toContain('130/80');
    expect(plan.exercise.join(' ')).toMatch(/Low-impact/);
  });

  it('renders fully in simple Arabic with ar lang', () => {
    const plan = recommendLifestyle(
      {
        diagnosis: 'Type 2 diabetes',
        conditions: [],
        labs: {
          hba1c: 9.1,
          systolic: null,
          ldl: null,
          triglycerides: null,
          microalbumin: 243,
          urineAcr: null,
          creatinine: 0.743,
          urea: 189,
          egfr: null,
        },
        weightKg: 82,
        ageYears: 50,
      },
      'ar',
    );
    expect(plan.targets.join(' ')).toContain('7.0%');
    expect(plan.diet.join(' ')).toContain('اليوريا');
    expect(plan.diet.join(' ')).toContain('189');
    expect(plan.exercise.join(' ')).toContain('30 دقيقة');
  });
});
