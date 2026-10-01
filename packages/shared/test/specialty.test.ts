import { describe, expect, it } from 'vitest';

import { drugsForSpecialty, orderKindsForSpecialty, SPECIALTY_LAB_KINDS } from '../src/clinical/specialty.js';
import { VITAL_KINDS } from '../src/domain/enums.js';
import { getVitalDefinition } from '../src/clinical/vitals.js';

describe('specialty scoping', () => {
  it('lists nephrology drugs, not diabetes ones first', () => {
    const drugs = drugsForSpecialty('nephrology');
    expect(drugs.length).toBeGreaterThan(0);
    expect(drugs.every((d) => d.specialties.includes('nephrology'))).toBe(true);
  });

  it('orders a nephrologist panel with creatinine first', () => {
    const ordered = orderKindsForSpecialty(VITAL_KINDS, 'nephrology');
    expect(ordered[0]).toBe('creatinine');
    expect(ordered).toHaveLength(VITAL_KINDS.length);
  });

  it('references only real vital kinds', () => {
    for (const kinds of Object.values(SPECIALTY_LAB_KINDS)) {
      for (const kind of kinds) {
        expect(() => getVitalDefinition(kind), kind).not.toThrow();
      }
    }
  });

  it('leaves the order untouched without a specialty', () => {
    expect(orderKindsForSpecialty(VITAL_KINDS, null)).toEqual([...VITAL_KINDS]);
  });
});
