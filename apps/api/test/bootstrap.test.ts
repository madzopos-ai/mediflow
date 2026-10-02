/**
 * First-owner bootstrap tests.
 *
 * This code creates an all-powerful account, so the refusal rules are the
 * actual subject under test: it must run exactly once on an empty database,
 * never weaken the password rule, and never touch an existing address. The
 * happy path is pinned too, including that the new account authenticates.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDatabase, migrate, type Db } from '../src/db/index.js';
import { bootstrapOwner, createClinicOwner } from '../src/services/bootstrap.js';
import { verifyPassword } from '../src/auth/password.js';

let db: Db;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bootstrap-'));
  db = openDatabase({ file: join(dir, 'test.db') });
  migrate(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('bootstrapOwner', () => {
  it('creates one active clinic and one active owner, nothing else', async () => {
    const result = await bootstrapOwner(db, {
      email: 'msmsyano@gmail.com',
      password: 'admin126342-strong',
      clinicName: 'Test Clinic',
    });

    expect(result.ownerEmail).toBe('msmsyano@gmail.com');
    expect(result.clinicName).toBe('Test Clinic');

    const user = db.prepare('SELECT role, is_active FROM users WHERE id = ?').get(result.ownerUserId) as {
      role: string;
      is_active: number;
    };
    expect(user.role).toBe('owner');
    expect(user.is_active).toBe(1);

    const clinic = db.prepare('SELECT is_active, timezone FROM clinics WHERE id = ?').get(result.clinicId) as {
      is_active: number;
      timezone: string;
    };
    expect(clinic.is_active).toBe(1);
    expect(clinic.timezone).toBe('Asia/Beirut');

    // No demo content smuggled in.
    expect((db.prepare('SELECT COUNT(*) AS n FROM patients').get() as { n: number }).n).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n).toBe(1);
  });

  it('stores a hash the password verifies against', async () => {
    const result = await bootstrapOwner(db, { email: 'a@b.test', password: 'a-strong-pass-1' });
    const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(result.ownerUserId) as {
      password_hash: string;
    };
    expect(row.password_hash).not.toContain('a-strong-pass-1');
    expect(await verifyPassword('a-strong-pass-1', row.password_hash)).toBe(true);
  });

  it('refuses a second run even for a different address', async () => {
    await bootstrapOwner(db, { email: 'first@example.test', password: 'first-password-1' });
    await expect(
      bootstrapOwner(db, { email: 'second@example.test', password: 'second-password-2' }),
    ).rejects.toMatchObject({ code: 'already_bootstrapped' });
    // And the failed attempt left no trace.
    expect((db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n).toBe(1);
  });

  it('rejects a short password with the same 10-char rule as signup', async () => {
    await expect(bootstrapOwner(db, { email: 'a@b.test', password: 'short' })).rejects.toMatchObject({
      code: 'weak_password',
    });
  });

  it('rejects a malformed email', async () => {
    await expect(
      bootstrapOwner(db, { email: 'not-an-email', password: 'a-strong-pass-1' }),
    ).rejects.toMatchObject({ code: 'invalid_email' });
  });

  it('lowercases and trims the email', async () => {
    const result = await bootstrapOwner(db, { email: '  Owner@Example.TEST ', password: 'a-strong-pass-1' });
    expect(result.ownerEmail).toBe('owner@example.test');
  });
});

describe('createClinicOwner (second, third, ... doctors)', () => {
  it('adds another full clinic on a non-empty database', async () => {
    await bootstrapOwner(db, { email: 'first@example.test', password: 'first-password-1' });
    const second = await createClinicOwner(db, {
      email: 'second@example.test',
      password: 'second-password-2',
      clinicName: 'Second Clinic',
    });
    expect(second.ownerEmail).toBe('second@example.test');
    expect(second.clinicId).not.toBe('');
    // Full kit, like the first: settings, schedule, active owner.
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM clinic_settings WHERE clinic_id = ?').get(second.clinicId) as { n: number }).n,
    ).toBe(1);
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM clinic_schedules WHERE clinic_id = ?').get(second.clinicId) as { n: number }).n,
    ).toBe(1);
    const user = db.prepare('SELECT role, is_active FROM users WHERE id = ?').get(second.ownerUserId) as {
      role: string;
      is_active: number;
    };
    expect(user.role).toBe('owner');
    expect(user.is_active).toBe(1);
  });

  it('refuses an address that already owns a clinic', async () => {
    await bootstrapOwner(db, { email: 'taken@example.test', password: 'taken-password-1' });
    await expect(
      createClinicOwner(db, { email: 'Taken@Example.Test ', password: 'other-password-2' }),
    ).rejects.toMatchObject({ code: 'email_taken' });
  });

  it('survives two clinics sharing one name', async () => {
    await bootstrapOwner(db, { email: 'a@example.test', password: 'a-password-11', clinicName: 'Same Name' });
    const second = await createClinicOwner(db, { email: 'b@example.test', password: 'b-password-22', clinicName: 'Same Name' });
    expect(second.clinicId).toBeTruthy();
    const slugs = db.prepare('SELECT slug FROM clinics').all() as { slug: string }[];
    expect(new Set(slugs.map((s) => s.slug)).size).toBe(2);
  });
});
