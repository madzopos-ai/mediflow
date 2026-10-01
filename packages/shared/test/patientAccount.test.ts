import { describe, expect, it } from 'vitest';

import {
  assertPatientPin,
  canonicalPatientPhone,
  createLinkTicket,
  derivePatientAccountId,
} from '../src/core/patientAccount.js';

describe('patientAccount', () => {
  it('canonicalises phone numbers', () => {
    expect(canonicalPatientPhone('+961 70 123 456')).toBe('+96170123456');
    expect(() => canonicalPatientPhone('123')).toThrow();
  });

  it('rejects short pins', () => {
    expect(() => assertPatientPin('12345')).toThrow();
    expect(() => assertPatientPin('123456')).not.toThrow();
  });

  it('derives a stable 64-hex id', async () => {
    const a = await derivePatientAccountId('+96170123456', '123456');
    const b = await derivePatientAccountId('+961 70 123 456', '123456');
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('separates pins and phones', async () => {
    const a = await derivePatientAccountId('+96170123456', '123456');
    const b = await derivePatientAccountId('+96170123456', '654321');
    const c = await derivePatientAccountId('+96170999999', '123456');
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });

  it('issues unambiguous tickets', () => {
    const t = createLinkTicket();
    expect(t.ticket).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/);
    expect(t.secret).toHaveLength(16);
  });
});
