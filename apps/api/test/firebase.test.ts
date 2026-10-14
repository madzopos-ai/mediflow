/**
 * Firebase identity exchange.
 *
 * Stubs stand in for Google: the verifier accepts any token of the form
 * `stub:<uid>`, and the reader serves scripted staff docs. What is pinned here
 * is our side of the contract - auto-provisioning, role validation, session
 * minting - not Google's token format.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createHarness, type Harness } from './harness.js';
import { setFirebaseTestDoubles } from '../src/auth/firebase.js';

describe('firebase exchange', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await createHarness();
  });

  afterAll(async () => {
    await h.close();
  });

  afterEach(() => {
    setFirebaseTestDoubles(null, null);
  });

  function stubAs(staff: { uid: string; email: string; name: string; role: string; clinicId: string } | null): void {
    setFirebaseTestDoubles(
      (idToken: string) => {
        const uid = idToken.startsWith('stub:') ? idToken.slice('stub:'.length) : '';
        if (!uid || !staff || staff.uid !== uid) throw new Error('bad stub token');
        return Promise.resolve({ uid, email: staff.email });
      },
      () => Promise.resolve(staff),
    );
  }

  it('provisions a clinic and user on first exchange and mints a session', async () => {
    stubAs({ uid: 'fb-owner-1', email: 'owner@clinic.test', name: 'Clinic Owner', role: 'owner', clinicId: 'fb-demo' });
    const res = await h.app.inject({
      method: 'POST',
      url: '/auth/firebase',
      payload: { idToken: 'stub:fb-owner-1' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { token: string; user: { clinicId: string; role: string } };
    expect(body.user.clinicId).toBe('fb-demo');
    expect(body.user.role).toBe('owner');

    // The minted session is a real API session.
    const me = await h.app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { authorization: `Bearer ${body.token}` },
    });
    expect(me.statusCode).toBe(200);

    // Repeating the exchange reuses the rows instead of duplicating them.
    const again = await h.app.inject({
      method: 'POST',
      url: '/auth/firebase',
      payload: { idToken: 'stub:fb-owner-1' },
    });
    expect(again.statusCode).toBe(200);
    const users = h.db
      .prepare('SELECT COUNT(*) AS n FROM users WHERE firebase_uid = ?')
      .get('fb-owner-1') as { n: number };
    expect(users.n).toBe(1);
  });

  it('links a legacy password-era account instead of duplicating it', async () => {
    // Clinics created before Firebase login existed already have a users row
    // with the same (clinic_id, email) and no firebase_uid. Exchanging must
    // attach to it, not INSERT a second row (UNIQUE would throw).
    const now = new Date().toISOString();
    h.db
      .prepare(
        `INSERT INTO users
          (id, clinic_id, email, password_hash, full_name, role, locale, firebase_uid,
           is_active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 1, ?, ?)`,
      )
      .run('usr-legacy-1', 'fb-demo', 'legacy@clinic.test', 'locked', 'Legacy Owner', 'owner', 'en', now, now);
    stubAs({ uid: 'fb-legacy-1', email: 'legacy@clinic.test', name: 'Legacy Owner', role: 'owner', clinicId: 'fb-demo' });
    const res = await h.app.inject({
      method: 'POST',
      url: '/auth/firebase',
      payload: { idToken: 'stub:fb-legacy-1' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { user: { id: string; clinicId: string } };
    expect(body.user.id).toBe('usr-legacy-1');
    expect(body.user.clinicId).toBe('fb-demo');
    const count = h.db
      .prepare('SELECT COUNT(*) AS n FROM users WHERE email = ?')
      .get('legacy@clinic.test') as { n: number };
    expect(count.n).toBe(1);
    const linked = h.db
      .prepare('SELECT firebase_uid AS uid FROM users WHERE id = ?')
      .get('usr-legacy-1') as { uid: string | null };
    expect(linked.uid).toBe('fb-legacy-1');
  });

  it('rejects an account with no staff record', async () => {
    stubAs(null);
    setFirebaseTestDoubles(
      () => Promise.resolve({ uid: 'fb-ghost', email: 'ghost@test.test' }),
      () => Promise.resolve(null),
    );
    const res = await h.app.inject({
      method: 'POST',
      url: '/auth/firebase',
      payload: { idToken: 'stub:fb-ghost' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects an unknown role rather than inventing privileges', async () => {
    stubAs({ uid: 'fb-weird', email: 'weird@test.test', name: 'Weird', role: 'superadmin', clinicId: 'fb-demo' });
    const res = await h.app.inject({
      method: 'POST',
      url: '/auth/firebase',
      payload: { idToken: 'stub:fb-weird' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('reports cleanly when Firebase is not configured', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/auth/firebase',
      payload: { idToken: 'real-token-but-no-server-config' },
    });
    // No test doubles and no FIREBASE_* env: the route must say so (400),
    // not crash (500) or mint anything (200).
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('bad_request');
  });
});
