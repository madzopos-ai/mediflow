/**
 * Lab-panel parser: realistic report excerpts, including OCR noise.
 *
 * The cases that matter are the ones that go wrong silently: a reference
 * range mistaken for a result, an OCR-mangled number stored as fact, or two
 * panels' values merged into one reading.
 */

import { describe, expect, it } from 'vitest';

import { parseLabPanel } from '../src/clinical/labPanel.js';

describe('parseLabPanel', () => {
  it('reads a standard English blood panel', () => {
    const text = [
      'COMPLETE BLOOD COUNT',
      'Hemoglobin 13.2 g/dL (13.0 - 17.0)',
      'Glucose Fasting 114 mg/dL (70 - 99)',
      'HbA1c 6.2 % (4.0 - 6.0)',
      'Creatinine 1.1 mg/dL (0.7 - 1.3)',
    ].join('\n');
    const values = parseLabPanel(text);
    const byKind = new Map(values.map((v) => [v.kind, v.value]));
    expect(byKind.get('hemoglobin')).toBe(13.2);
    expect(byKind.get('fasting_glucose')).toBe(114);
    expect(byKind.get('hba1c')).toBe(6.2);
    expect(byKind.get('creatinine')).toBe(1.1);
  });

  it('never takes a number from inside a reference range', () => {
    // No result on the line at all - only the interval. Must yield nothing,
    // not a "result" of 13.0.
    const values = parseLabPanel('Hemoglobin (13.0 - 17.0)');
    expect(values).toEqual([]);
  });

  it('rejects physically impossible OCR misreads', () => {
    // "6.2" misread as "62": outside any HbA1c range, so dropped.
    const values = parseLabPanel('HbA1c 62 %');
    expect(values).toEqual([]);
  });

  it('reads an Arabic-labelled panel', () => {
    const text = ['السكر 130', 'الهيموجلوبين 12.5', 'الكرياتينين 0.9'].join('\n');
    const byKind = new Map(parseLabPanel(text).map((v) => [v.kind, v.value]));
    expect(byKind.get('fasting_glucose')).toBe(130);
    expect(byKind.get('hemoglobin')).toBe(12.5);
    expect(byKind.get('creatinine')).toBe(0.9);
  });

  it('reads a lipid panel and keeps one value per kind', () => {
    const text = ['LDL 130 mg/dL', 'HDL 45 mg/dL', 'Triglycerides 160 mg/dL', 'LDL 131 mg/dL'].join('\n');
    const values = parseLabPanel(text);
    const byKind = new Map(values.map((v) => [v.kind, v.value]));
    expect(byKind.get('ldl')).toBe(130);
    expect(byKind.get('hdl')).toBe(45);
    expect(byKind.get('triglycerides')).toBe(160);
  });

  it('returns nothing for prose without measurements', () => {
    expect(parseLabPanel('Patient advised to repeat the test in three months.')).toEqual([]);
  });

  it('reads a real kidney panel, OCR misspellings included', () => {
    const text = [
      'Creatinine 0.743 mgd 06 LI',
      'Urea 189 mgdl 128i 28',
      'Microalbuminuria H 243 * mgL 0m',
      'Creatinine urine. 513 mgd 40',
      'HbalC 9.1% <63',
      'Spot urine ACRAlb/Creat Ratio" H 472 * 0 EC',
    ].join('\n');
    const byKind = new Map(parseLabPanel(text).map((v) => [v.kind, v.value]));
    expect(byKind.get('creatinine')).toBe(0.743);
    expect(byKind.get('hba1c')).toBe(9.1);
    expect(byKind.get('microalbumin')).toBe(243);
    expect(byKind.get('urine_acr')).toBe(472);
    // Urine creatinine is a different test: it must not land in serum creatinine.
    expect(byKind.get('creatinine')).not.toBe(513);
  });

  it('reads a CBC panel with the new cell-count kinds', () => {
    const text = [
      'CBC',
      'WBC 6.8 K/uL (4.5 - 11.0)',
      'RBC 4.9 M/uL (4.5 - 5.9)',
      'HGB 14.1 g/dL',
      'HCT 42.5 %',
      'PLT 250 K/uL',
      'MCV 88.2 fL',
    ].join('\n');
    const byKind = new Map(parseLabPanel(text).map((v) => [v.kind, v.value]));
    expect(byKind.get('wbc')).toBe(6.8);
    expect(byKind.get('rbc')).toBe(4.9);
    expect(byKind.get('hemoglobin')).toBe(14.1);
    expect(byKind.get('hematocrit')).toBe(42.5);
    expect(byKind.get('platelets')).toBe(250);
    expect(byKind.get('mcv')).toBe(88.2);
  });
});
