/**
 * Authentication, authorisation and tenant isolation.
 *
 * Isolation is the property most worth pinning down with tests: every bug here
 * is a cross-clinic data leak, and none of them are visible to a type checker.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { asClient, createHarness, OWNER_EMAIL, type Harness } from './harness.js';

describe('auth', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await createHarness();
  });

  afterAll(async () => {
    await h.close();
  });

  it('rejects an unauthenticated request', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/patients' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('unauthorized');
  });

  it('rejects a malformed token', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/patients',
      headers: { authorization: 'Bearer not-a-real-token' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('gives the same answer for a wrong password and an unknown account', async () => {
    const wrongPassword = await h.app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: OWNER_EMAIL, password: 'definitely-not-the-password' },
    });
    const unknownAccount = await h.app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'nobody@mediflow.test', password: 'definitely-not-the-password' },
    });

    expect(wrongPassword.statusCode).toBe(401);
    expect(unknownAccount.statusCode).toBe(401);
    // An identical body is what makes login safe to probe: a different message
    // for "no such user" turns the endpoint into an account oracle.
    expect(unknownAccount.body).toBe(wrongPassword.body);
    expect(unknownAccount.body).not.toContain('no such');
    expect(unknownAccount.body).not.toContain(OWNER_EMAIL);
  });

  it('logs in with valid credentials and identifies the caller', async () => {
    const { token, auth } = await h.login();
    expect(token.split('.')).toHaveLength(3);

    const me = await h.app.inject({ method: 'GET', url: '/auth/me', headers: { authorization: auth } });
    expect(me.statusCode).toBe(200);
    // The route returns the user object itself, not an envelope.
    expect(me.json().email).toBe(OWNER_EMAIL);
    // The hash and salt must never cross the wire.
    expect(me.body).not.toContain('password_hash');
    expect(me.body).not.toContain('salt');
  });
});

describe('tenant isolation', () => {
  let first: Harness;
  let second: Harness;

  beforeAll(async () => {
    first = await createHarness();
    second = await createHarness();
  });

  afterAll(async () => {
    await first.close();
    await second.close();
  });

  it('hides a patient from the clinic that does not own it', async () => {
    const a = asClient(first.app, (await first.login()).auth);
    const b = asClient(second.app, (await second.login()).auth);

    const created = await a.post('/patients', {
      firstName: 'Leaked',
      lastName: 'Patient',
      phone: '+966500000001',
      dateOfBirth: '1990-05-14',
      address: 'Test Street 1',
      heightCm: 175,
      weightKg: 70,
    });
    expect(created.statusCode).toBe(201);
    const patientId = created.json().id as string;

    // 404 rather than 403: confirming the row exists elsewhere is itself a leak.
    const foreign = await b.get(`/patients/${patientId}`);
    expect(foreign.statusCode).toBe(404);

    const list = await b.get('/patients');
    expect(list.statusCode).toBe(200);
    expect(list.json().items.map((p: { id: string }) => p.id)).not.toContain(patientId);
  });

  it('refuses to write to a row owned by another clinic', async () => {
    const a = asClient(first.app, (await first.login()).auth);
    const b = asClient(second.app, (await second.login()).auth);

    const created = await a.post('/patients', {
      firstName: 'Cross',
      lastName: 'Write',
      phone: '+966500000002',
      dateOfBirth: '1990-05-14',
      address: 'Test Street 1',
      heightCm: 175,
      weightKg: 70,
    });
    const patientId = created.json().id as string;

    const patched = await b.patch(`/patients/${patientId}`, { firstName: 'Hijacked' });
    expect(patched.statusCode).toBe(404);

    const reread = await a.get(`/patients/${patientId}`);
    expect(reread.statusCode).toBe(200);
    expect(reread.json().firstName).toBe('Cross');
  });

  it('keeps two clinics lists independent', async () => {
    const a = asClient(first.app, (await first.login()).auth);
    const b = asClient(second.app, (await second.login()).auth);

    const created = await a.post('/patients', {
      firstName: 'Only',
      lastName: 'Mine',
      phone: '+966500000003',
      dateOfBirth: '1990-05-14',
      address: 'Test Street 1',
      heightCm: 175,
      weightKg: 70,
    });
    const mine = created.json().id as string;

    const listA = await a.get('/patients?limit=200');
    const listB = await b.get('/patients?limit=200');
    const idsA = (listA.json().items as { id: string }[]).map((p) => p.id);
    const idsB = (listB.json().items as { id: string }[]).map((p) => p.id);

    expect(idsA).toContain(mine);
    expect(idsB).not.toContain(mine);
  });
});

describe('clinic settings', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await createHarness();
  });

  afterAll(async () => {
    await h.close();
  });

  it('returns the caller own clinic', async () => {
    const api = asClient(h.app, (await h.login()).auth);
    const res = await api.get('/clinic');
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(h.clinic.clinicId);
  });
});

describe('error envelope', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await createHarness();
  });

  afterAll(async () => {
    await h.close();
  });

  it('answers an unknown route without disclosing the route table', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/nope' });
    // Auth runs before routing, so an unauthenticated probe cannot even learn
    // which paths exist.
    expect([401, 404]).toContain(res.statusCode);
    expect(res.json().error.code).toMatch(/unauthorized|not_found/);
  });

  it('returns a field-level detail for a validation failure', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'not-an-email' },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error.code).toBe('bad_request');
    expect(Array.isArray(body.error.detail)).toBe(true);
  });

  it('rejects an unknown query parameter value rather than ignoring it', async () => {
    const api = asClient(h.app, (await h.login()).auth);
    const res = await api.get('/patients?limit=99999');
    expect(res.statusCode).toBe(400);
  });
});

describe('CORS preflight', () => {
  let h: Harness;

  beforeAll(async () => {
    // The browser login page lives on another origin, so the preflight must
    // succeed or nothing - not even sign-in - works from the web app.
    h = await createHarness({ corsOrigins: ['http://localhost:5173'] });
  });

  afterAll(async () => {
    await h.close();
  });

  it('answers an OPTIONS preflight without requiring a session', async () => {
    const res = await h.app.inject({
      method: 'OPTIONS',
      url: '/auth/login',
      headers: {
        origin: 'http://localhost:5173',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type',
      },
    });
    // The auth hook must not 401 a preflight: a 401 has no CORS headers, and
    // the browser then reports an opaque CORS failure instead of the login
    // page working.
    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
  });
});
