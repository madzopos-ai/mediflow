/**
 * Practice learning: the doctor's own habits, ranked.
 *
 * The cases that matter: spelling variants of one diagnosis still match,
 * the majority dose wins over one-off experiments, and other diagnoses
 * never leak into the ranking.
 */

import { describe, expect, it } from 'vitest';

import { learnPrescribingPatterns, type PracticeRecord } from '../src/clinical/practice.js';

const RECORDS: PracticeRecord[] = [
  {
    diagnosis: 'Type 2 diabetes',
    items: [{ drug: 'Metformin', dose: '500mg', frequency: 'twice daily' }],
    createdAt: '2026-09-01T10:00:00.000Z',
  },
  {
    diagnosis: 'DM2',
    items: [
      { drug: 'metformin', dose: '500mg', frequency: 'twice daily' },
      { drug: 'Atorvastatin', dose: '20mg', frequency: 'once nightly' },
    ],
    createdAt: '2026-09-10T10:00:00.000Z',
  },
  {
    diagnosis: 'Type 2 Diabetes',
    items: [{ drug: 'Metformin', dose: '850mg', frequency: 'twice daily' }],
    createdAt: '2026-09-20T10:00:00.000Z',
  },
  {
    diagnosis: 'Hypertension',
    items: [{ drug: 'Amlodipine', dose: '5mg', frequency: 'once daily' }],
    createdAt: '2026-09-21T10:00:00.000Z',
  },
];

describe('learnPrescribingPatterns', () => {
  it('matches spelling variants of one diagnosis', () => {
    const patterns = learnPrescribingPatterns(RECORDS, 'diabetes type 2');
    expect(patterns[0]?.drug).toBe('Metformin');
    expect(patterns[0]?.times).toBe(3);
  });

  it('follows the majority dose, not the latest experiment', () => {
    const patterns = learnPrescribingPatterns(RECORDS, 'DM2');
    expect(patterns[0]?.dose).toBe('500mg');
    expect(patterns[0]?.frequency).toBe('twice daily');
  });

  it('never mixes in other diagnoses', () => {
    const patterns = learnPrescribingPatterns(RECORDS, 'diabetes');
    expect(patterns.some((p) => p.drug === 'Amlodipine')).toBe(false);
  });

  it('returns nothing unknown instead of guessing', () => {
    expect(learnPrescribingPatterns(RECORDS, 'migraine')).toEqual([]);
    expect(learnPrescribingPatterns([], 'diabetes')).toEqual([]);
  });

  it('learns the dose from orders written at similar labs', () => {
    const records: PracticeRecord[] = [
      {
        diagnosis: 'Type 2 diabetes',
        items: [{ drug: 'Metformin', dose: '500mg', frequency: 'twice daily' }],
        createdAt: '2026-09-01T10:00:00.000Z',
        labs: { hba1c: 7.1 },
      },
      {
        diagnosis: 'Type 2 diabetes',
        items: [{ drug: 'Metformin', dose: '1000mg', frequency: 'twice daily' }],
        createdAt: '2026-09-10T10:00:00.000Z',
        labs: { hba1c: 9.3 },
      },
    ];
    // Same history, different patient: the dose follows the labs.
    const high = learnPrescribingPatterns(records, 'diabetes', { hba1c: 9.1 });
    expect(high[0]?.dose).toBe('1000mg');
    expect(high[0]?.basis).toContain('HbA1c');

    const low = learnPrescribingPatterns(records, 'diabetes', { hba1c: 7.0 });
    expect(low[0]?.dose).toBe('500mg');
  });
});
