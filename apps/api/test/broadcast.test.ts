/**
 * Broadcast tests: one message to many patients, with per-patient results.
 *
 * The property that matters: a broadcast never dies on one bad recipient.
 * Unknown ids, missing numbers and opt-outs are reported as skips while the
 * rest queue normally - and the same consent rules as single send apply.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { asClient, createHarness, type Harness } from './harness.js';

describe('broadcast', () => {
  let h: Harness;
  let api: ReturnType<typeof asClient>;
  let ok1: string;
  let ok2: string;
  let optedOut: string;

  async function makePatient(firstName: string, phone: string): Promise<string> {
    const created = await api.post('/patients', {
      firstName,
      lastName: 'Broadcast',
      phone,
      dateOfBirth: '1990-01-01',
      address: 'Broadcast Street 1',
      heightCm: 170,
      weightKg: 70,
    });
    expect(created.statusCode).toBe(201);
    return (created.json() as { id: string }).id;
  }

  beforeAll(async () => {
    h = await createHarness();
    api = asClient(h.app, (await h.login()).auth);
    ok1 = await makePatient('First', '+966500000331');
    ok2 = await makePatient('Second', '+966500000332');
    optedOut = await makePatient('Third', '+966500000333');
    const out = await api.post(`/patients/${optedOut}/opt-out`, {});
    expect([200, 201, 204].includes(out.statusCode)).toBe(true);
  });

  afterAll(async () => {
    await h.close();
  });

  it('queues for every valid recipient', async () => {
    const res = await api.post('/messages/broadcast', {
      patientIds: [ok1, ok2],
      body: 'Reminder: your appointment is tomorrow.',
    });
    expect(res.statusCode).toBe(201);
    const json = res.json() as { queued: { patientId: string }[]; skipped: unknown[] };
    expect(json.queued.map((q) => q.patientId).sort()).toEqual([ok1, ok2].sort());
    expect(json.skipped).toEqual([]);
  });

  it('skips bad recipients individually with reasons', async () => {
    const res = await api.post('/messages/broadcast', {
      patientIds: [ok1, optedOut, 'pat_nonexistent', ok1],
      body: 'Promo blast.',
    });
    expect(res.statusCode).toBe(201);
    const json = res.json() as {
      queued: { patientId: string }[];
      skipped: { patientId: string; reason: string }[];
    };
    // Duplicate id sends once.
    expect(json.queued.map((q) => q.patientId)).toEqual([ok1]);
    const reasons = Object.fromEntries(json.skipped.map((s) => [s.patientId, s.reason]));
    expect(reasons).toEqual({ [optedOut]: 'opted-out', pat_nonexistent: 'not-found' });
  });

  it('rejects empty and oversized batches', async () => {
    const empty = await api.post('/messages/broadcast', { patientIds: [], body: 'Hi.' });
    expect(empty.statusCode).toBe(400);
    const big = await api.post('/messages/broadcast', {
      patientIds: Array.from({ length: 101 }, (_, i) => `pat_${i}`),
      body: 'Hi.',
    });
    expect(big.statusCode).toBe(400);
  });
});
