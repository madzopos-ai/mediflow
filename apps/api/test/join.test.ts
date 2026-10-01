/**
 * Public join: code, verify, own password, forced profile completion.
 *
 * The guarantees: nothing exists before the code checks out, codes are
 * single-use and hashed, a reused email or a wrong code fails loudly, and a
 * fresh account reports profileComplete false until phone and address land.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createHarness, type Harness } from './harness.js';

describe('join', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await createHarness();
  });

  afterAll(async () => {
    await h.close();
  });

  async function codeFor(email: string, accountType = 'doctor'): Promise<string> {
    const res = await h.app.inject({
      method: 'POST',
      url: '/auth/signup/code',
      payload: { email, accountType },
    });
    expect(res.statusCode).toBe(200);
    return (res.json() as { devCode: string }).devCode;
  }

  it('creates a doctor practice pending, then the admin approves it', async () => {
    const code = await codeFor('newdoc@mediflow.test');
    const res = await h.app.inject({
      method: 'POST',
      url: '/auth/signup/verify',
      payload: {
        email: 'newdoc@mediflow.test',
        code,
        accountType: 'doctor',
        fullName: 'New Doctor',
        password: 'Doctor!2026pass',
        specialty: 'cardiology',
        phone: '+966500000400',
      },
    });
    expect(res.statusCode).toBe(201);
    // Pending, not signed in: no token until the reseller approves.
    expect((res.json() as { pending: boolean }).pending).toBe(true);
    expect((res.json() as { token?: string }).token).toBeUndefined();

    const blocked = await h.app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'newdoc@mediflow.test', password: 'Doctor!2026pass' },
    });
    expect(blocked.statusCode).toBe(403);
    expect((blocked.json() as { error: { code: string } }).error.code).toBe('pending_approval');

    // The reseller approves (the admin:approve command does exactly this).
    const now = new Date().toISOString();
    const user = h.db.prepare('SELECT id, clinic_id FROM users WHERE email = ?').get('newdoc@mediflow.test') as {
      id: string;
      clinic_id: string;
    };
    h.db.prepare('UPDATE users SET is_active = 1, updated_at = ? WHERE id = ?').run(now, user.id);
    h.db.prepare('UPDATE clinics SET is_active = 1, updated_at = ? WHERE id = ?').run(now, user.clinic_id);

    const login = await h.app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'newdoc@mediflow.test', password: 'Doctor!2026pass' },
    });
    expect(login.statusCode).toBe(200);
    const body = login.json() as { token: string; user: { role: string; clinicId: string } };
    expect(body.user.role).toBe('owner');

    // Signed in, but the profile gate sees the missing address.
    const me = await h.app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { authorization: `Bearer ${body.token}` },
    });
    expect(me.statusCode).toBe(200);
    expect((me.json() as { profileComplete: boolean }).profileComplete).toBe(false);

    // Reusing the same code fails: single use.
    const replay = await h.app.inject({
      method: 'POST',
      url: '/auth/signup/verify',
      payload: {
        email: 'newdoc@mediflow.test',
        code,
        accountType: 'doctor',
        fullName: 'New Doctor',
        password: 'Doctor!2026pass',
        specialty: 'cardiology',
      },
    });
    expect(replay.statusCode).toBe(401);
  });

  it('refuses doctors without a specialty and duplicate emails', async () => {
    const code = await codeFor('nospec@mediflow.test');
    const res = await h.app.inject({
      method: 'POST',
      url: '/auth/signup/verify',
      payload: {
        email: 'nospec@mediflow.test',
        code,
        accountType: 'doctor',
        fullName: 'No Spec',
        password: 'Doctor!2026pass',
      },
    });
    expect(res.statusCode).toBe(400);

    const taken = await h.app.inject({
      method: 'POST',
      url: '/auth/signup/code',
      payload: { email: 'newdoc@mediflow.test', accountType: 'clinic' },
    });
    expect(taken.statusCode).toBe(409);
  });

  it('completes the profile through self-service', async () => {
    const login = await h.app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'newdoc@mediflow.test', password: 'Doctor!2026pass' },
    });
    const token = (login.json() as { token: string }).token;
    const patched = await h.app.inject({
      method: 'PATCH',
      url: '/auth/profile',
      headers: { authorization: `Bearer ${token}` },
      payload: { address: 'Clinic Street 1' },
    });
    expect(patched.statusCode).toBe(200);
    expect((patched.json() as { profileComplete: boolean }).profileComplete).toBe(true);
  });
});
