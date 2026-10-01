/**
 * Dictation structuring + spoken Arabic numbers.
 *
 * The safety properties under test, in order of importance:
 *   1. Nothing is guessed. An unlabelled number never becomes a chart reading,
 *      because a wrong auto-filled vital is worse than no suggestion at all.
 *   2. The brief's canonical dictation lands in every bucket at once.
 *   3. Spoken Arabic numbers and Arabic-Indic digits both parse.
 */

import { describe, expect, it } from 'vitest';

import { summarizeDictation } from '../src/clinical/voiceSummary.js';
import { arabicNumbersToDigits } from '../src/clinical/arabicNumbers.js';

describe('arabicNumbersToDigits', () => {
  it('adds the parts of a composite Arabic number', () => {
    // 100 + 40, with the conjunction glued to "أربعين" as Arabic writes it.
    expect(arabicNumbersToDigits('الضغط مئة وأربعين')).toBe('الضغط 140');
  });

  it('reads a compound hundreds-and-tens pair', () => {
    expect(arabicNumbersToDigits('مئة وتسعون')).toBe('190');
  });

  it('reads a units-plus-tens phrase', () => {
    expect(arabicNumbersToDigits('ثلاثة وعشرون')).toContain('23');
  });

  it('leaves text with no number words untouched', () => {
    const input = 'المريض يشكو من صداع';
    expect(arabicNumbersToDigits(input)).toBe('المريض يشكو من صداع');
  });

  it('does not read a number word that is really a word fragment', () => {
    // "ست" is the six, but not inside an unrelated longer word.
    const out = arabicNumbersToDigits('ستritis بسيطة');
    expect(out).not.toContain('6');
  });
});

describe('summarizeDictation', () => {
  it('extracts an Arabic diagnosis line', () => {
    const summary = summarizeDictation('المريض يشكو من صداع\nالتشخيص: صداع نصفي');
    expect(summary.diagnosis).toBe('صداع نصفي');
  });

  it('extracts an English diagnosis line', () => {
    const summary = summarizeDictation('fever 3 days\nDiagnosis: viral pharyngitis');
    expect(summary.diagnosis).toBe('viral pharyngitis');
  });

  it('classifies dose lines as medications (ar + en)', () => {
    const summary = summarizeDictation('ميتفورمين 500 ملغ مرتين يوميا\nparacetamol 500mg twice daily');
    expect(summary.medications).toHaveLength(2);
    expect(summary.labOrders).toHaveLength(0);
  });

  it('classifies test names as lab orders', () => {
    const summary = summarizeDictation('اطلب تحليل سكري تراكمي\nHbA1c and creatinine test');
    expect(summary.labOrders.length).toBeGreaterThan(0);
    expect(summary.medications).toHaveLength(0);
  });

  it('strips the request verb so the lab order reads as a test name', () => {
    const summary = summarizeDictation('اطلب تحليل سكري تراكمي');
    expect(summary.labOrders).toContain('تحليل سكري تراكمي');
  });

  it('returns empty buckets for unstructured chatter', () => {
    const summary = summarizeDictation('المريض بحالة جيدة والحمد لله');
    expect(summary.diagnosis).toBeNull();
    expect(summary.medications).toEqual([]);
    expect(summary.labOrders).toEqual([]);
    expect(summary.vitals).toEqual([]);
    expect(summary.prescriptions).toEqual([]);
  });

  it('splits a dictated prescription into drug, dose, frequency and duration', () => {
    const summary = summarizeDictation('أضف أملوديبين 5 ملغ يومياً لمدة شهر');
    expect(summary.prescriptions).toHaveLength(1);
    const rx = summary.prescriptions[0]!;
    expect(rx.drug).toBeTruthy();
    expect(rx.dose).toBeTruthy();
    expect(rx.frequency).toBeTruthy();
    expect(rx.durationDays).toBe(30);
  });

  it('reads a dual-form duration as the right number of days', () => {
    const summary = summarizeDictation('أموكسيسيلين 500 ملغ ثلاث مرات لمدة أسبوعين');
    expect(summary.prescriptions[0]?.durationDays).toBe(14);
  });

  it('resolves a brand name to its generic so safety engines can screen it', () => {
    const summary = summarizeDictation('Zoloft 50mg once daily');
    expect(summary.prescriptions[0]?.drug.toLowerCase()).toBe('sertraline');
  });

  it('reads a blood-pressure pair into two readings', () => {
    const summary = summarizeDictation('المريض يعاني من صداع ضغط 140/90');
    const kinds = summary.vitals.map((v) => `${v.kind}=${v.value}`);
    expect(kinds).toContain('systolic_bp=140');
    expect(kinds).toContain('diastolic_bp=90');
  });

  it('reads Arabic-Indic digits and a spoken pair the same way', () => {
    const summary = summarizeDictation('الضغط ١٤٠ على ٩٠');
    const kinds = summary.vitals.map((v) => `${v.kind}=${v.value}`);
    expect(kinds).toContain('systolic_bp=140');
    expect(kinds).toContain('diastolic_bp=90');
  });

  it('never guesses an unlabelled number into a reading', () => {
    const summary = summarizeDictation('أملوديبين 5 ملغdaily');
    expect(summary.vitals).toEqual([]);
  });

  it('attributes a lone low blood-pressure number to the diastolic', () => {
    // "الضغط 90" means the diastolic: filing it as a systolic would raise a
    // false critical hypotension alert.
    const summary = summarizeDictation('الضغط 90');
    expect(summary.vitals).toEqual([expect.objectContaining({ kind: 'diastolic_bp', value: 90 })]);
  });

  it('keeps the last reading per kind when a vital is dictated twice', () => {
    const summary = summarizeDictation('النبض 80، النبض 96');
    expect(summary.vitals).toEqual([expect.objectContaining({ kind: 'pulse', value: 96 })]);
  });

  it('handles the brief\'s full dictation in every bucket at once', () => {
    const summary = summarizeDictation(
      'المريض يعاني من صداع ضغط 140/90، أضف أملوديبين 5 ملغ يومياً وطلب تحليل صور دم',
    );
    expect(summary.vitals.map((v) => v.value)).toContain(140);
    expect(summary.prescriptions).toHaveLength(1);
    expect(summary.labOrders).toHaveLength(1);
  });

  it('keeps vitals and medications out of each other\'s buckets', () => {
    const summary = summarizeDictation('الحرارة 38.5 والنبض 96');
    expect(summary.vitals).toEqual([
      expect.objectContaining({ kind: 'temperature', value: 38.5 }),
      expect.objectContaining({ kind: 'pulse', value: 96 }),
    ]);
    expect(summary.medications).toEqual([]);
  });
});
