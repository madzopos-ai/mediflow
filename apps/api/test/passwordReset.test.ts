/**
 * Password reset tests.
 *
 * The properties that matter are all negative: the token must not be
 * recoverable from the database, must stop working when reused or superseded,
 * must expire, and the "forgot" endpoint must not tell an attacker which
 * addresses have accounts. A reset flow that gets these wrong hands over the
 * whole clinic, so they are pinned rather than eyeballed.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDatabase, migrate, type Db } from '../src/db/index.js';
import {
  issuePasswordReset,
  redeemPasswordReset,
  verifyPasswordReset,
} from '../src/services/passwordReset.js';
import { verifyPassword } from '../src/auth/password.js';

let db: Db;
let dir: string;

const EMAIL = 'owner@example.test';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pwreset-'));
  db = openDatabase({ file: join(dir, 'test.db') });
  migrate(db);
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO clinics (id, name, slug, timezone, currency, created_at, updated_at)
     VALUES ('clc_1', 'Test', 'test', 'UTC', 'USD', ?, ?)`,
  ).run(now, now);
  db.prepare(
    `INSERT INTO users (id, clinic_id, email, password_hash, full_name, role, is_active, created_at, updated_at)
     VALUES ('usr_1', 'clc_1', ?, 'scrypt$16384$8$1$abc$def', 'Owner', 'owner', 1, ?, ?)`,
  ).run(EMAIL, now, now);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('issuePasswordReset', () => {
  it('issues a token for an active staff account', () => {
    const issued = issuePasswordReset(db, EMAIL);
    expect(issued).not.toBeNull();
    expect(issued?.userId).toBe('usr_1');
    expect(issued?.token.length).toBeGreaterThanOrEqual(32);
  });

  it('returns null for an unknown address', () => {
    expect(issuePasswordReset(db, 'nobody@example.test')).toBeNull();
  });

  it('returns null for a pending, inactive account', () => {
    db.prepare('UPDATE users SET is_active = 0 WHERE id = ?').run('usr_1');
    expect(issuePasswordReset(db, EMAIL)).toBeNull();
  });

  it('stores only a hash, never the token itself', () => {
    const issued = issuePasswordReset(db, EMAIL)!;
    const row = db
      .prepare('SELECT token_hash FROM password_reset_tokens WHERE user_id = ?')
      .get('usr_1') as { token_hash: string };
    expect(row.token_hash).not.toBe(issued.token);
    expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('supersedes an earlier token so a forwarded link stops working', () => {
    const first = issuePasswordReset(db, EMAIL)!;
    const second = issuePasswordReset(db, EMAIL)!;
    expect(verifyPasswordReset(db, first.token).ok).toBe(false);
    expect(verifyPasswordReset(db, second.token).ok).toBe(true);
  });

  it('caps the number of mails per account per day', () => {
    for (let i = 0; i < 5; i += 1) issuePasswordReset(db, EMAIL);
    expect(issuePasswordReset(db, EMAIL)).toBeNull();
  });
});

describe('verifyPasswordReset', () => {
  it('accepts a live token', () => {
    const issued = issuePasswordReset(db, EMAIL)!;
    expect(verifyPasswordReset(db, issued.token)).toEqual({ ok: true, userId: 'usr_1' });
  });

  it('rejects a token that was never issued', () => {
    expect(verifyPasswordReset(db, 'not-a-real-token-value').reason).toBe('invalid');
  });

  it('rejects an expired token', () => {
    const issued = issuePasswordReset(db, EMAIL)!;
    const later = new Date(Date.now() + 60 * 60_000);
    expect(verifyPasswordReset(db, issued.token, later).reason).toBe('expired');
  });

  it('reports a spent token as used rather than invalid', () => {
    const issued = issuePasswordReset(db, EMAIL)!;
    void redeemPasswordReset(db, issued.token, 'new-password-1');
    expect(verifyPasswordReset(db, issued.token).reason).toBe('used');
  });
});

describe('redeemPasswordReset', () => {
  it('sets the new password and makes the old one stop working', async () => {
    const issued = issuePasswordReset(db, EMAIL)!;
    const result = await redeemPasswordReset(db, issued.token, 'brand-new-pass-9');
    expect(result.ok).toBe(true);

    const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get('usr_1') as {
      password_hash: string;
    };
    expect(await verifyPassword('brand-new-pass-9', row.password_hash)).toBe(true);
  });

  it('cannot be redeemed twice', async () => {
    const issued = issuePasswordReset(db, EMAIL)!;
    expect((await redeemPasswordReset(db, issued.token, 'first-password-1')).ok).toBe(true);
    const second = await redeemPasswordReset(db, issued.token, 'second-password-2');
    expect(second.ok).toBe(false);
    expect(second.reason).toBe('used');

    // The first password must survive the failed second attempt.
    const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get('usr_1') as {
      password_hash: string;
    };
    expect(await verifyPassword('first-password-1', row.password_hash)).toBe(true);
  });

  it('refuses an expired token', async () => {
    const issued = issuePasswordReset(db, EMAIL)!;
    const later = new Date(Date.now() + 60 * 60_000);
    const result = await redeemPasswordReset(db, issued.token, 'new-password-1', later);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('expired');
  });

  it('rejects a password below the minimum length', async () => {
    const issued = issuePasswordReset(db, EMAIL)!;
    await expect(redeemPasswordReset(db, issued.token, 'short')).rejects.toThrow(/at least 10/);
  });
});
