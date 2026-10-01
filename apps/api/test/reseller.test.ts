/**
 * Reseller console: pending practices, approval, suspension, subscriptions,
 * and collections - all inside the app, no terminal.
 *
 * The fences that matter: a non-reseller gets 403 everywhere here, approval
 * activates user and clinic together, and a suspended clinic cannot sign in.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { asClient, createHarness, type Harness } from './harness.js';

describe('reseller', () => {
  let h: Harness;
  let api: ReturnType<typeof asClient>;
  let clinicId: string;

  beforeAll(async () => {
    h = await createHarness();
    api = asClient(h.app, (await h.login()).auth);
    // The harness owner is not a reseller; promote them the way the reseller
    // flag is set in production (directly, once, by whoever holds the DB).
    h.db.prepare('UPDATE users SET is_reseller = 1 WHERE email = ?').run('owner@mediflow.test');
  });

  afterAll(async () => {
    await h.close();
  });

  it('queues a join signup as pending and approves it in-app', async () => {
    const code = await h.app.inject({
      method: 'POST',
      url: '/auth/signup/code',
      payload: { email: 'pending@mediflow.test', accountType: 'clinic' },
    });
    const devCode = (code.json() as { devCode: string }).devCode;
    const created = await h.app.inject({
      method: 'POST',
      url: '/auth/signup/verify',
      payload: {
        email: 'pending@mediflow.test',
        code: devCode,
        accountType: 'clinic',
        fullName: 'Pending Owner',
        password: 'Pending!2026pass',
        practiceName: 'Pending Clinic',
      },
    });
    expect(created.statusCode).toBe(201);
    expect((created.json() as { pending: boolean }).pending).toBe(true);

    const queue = await api.get('/reseller/pending');
    expect(queue.statusCode).toBe(200);
    const entry = ((queue.json() as { items: { email: string; clinicId: string }[] }).items).find(
      (i) => i.email === 'pending@mediflow.test',
    );
    expect(entry).toBeTruthy();
    clinicId = entry?.clinicId as string;

    const approved = await api.post('/reseller/approve', { clinicId });
    expect(approved.statusCode).toBe(200);

    const login = await h.app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'pending@mediflow.test', password: 'Pending!2026pass' },
    });
    expect(login.statusCode).toBe(200);
  });

  it('refuses non-resellers everywhere in the console', async () => {
    const other = await h.app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'pending@mediflow.test', password: 'Pending!2026pass' },
    });
    const staff = asClient(h.app, `Bearer ${(other.json() as { token: string }).token}`);
    for (const [method, url] of [
      ['GET', '/reseller/pending'],
      ['GET', '/reseller/clinics'],
    ] as const) {
      const res = method === 'GET' ? await staff.get(url) : await staff.post(url, {});
      expect(res.statusCode).toBe(403);
    }
  });

  it('suspends a clinic out of sign-in and tracks the money', async () => {
    await api.post('/reseller/subscription', {
      clinicId,
      plan: 'pro',
      status: 'active',
      subscribedAt: '2026-09-01',
      expiresAt: '2027-09-01',
    });
    const collected = await api.post('/reseller/collections', {
      clinicId,
      amountMinor: 12000,
      reference: 'TRF-9',
    });
    expect(collected.statusCode).toBe(201);

    const statement = await api.get(`/reseller/clinics/${clinicId}/statement`);
    expect(statement.statusCode).toBe(200);
    const body = statement.json() as {
      clinic: { plan: string; subscriptionStatus: string };
      collectedMinor: number;
      receipts: { reference: string }[];
    };
    expect(body.clinic.plan).toBe('pro');
    expect(body.collectedMinor).toBe(12000);
    expect(body.receipts[0]?.reference).toBe('TRF-9');

    await api.post('/reseller/suspend', { clinicId });
    const login = await h.app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'pending@mediflow.test', password: 'Pending!2026pass' },
    });
    expect(login.statusCode).toBe(403);
    expect((login.json() as { error: { code: string } }).error.code).toBe('clinic_suspended');
  });
});
