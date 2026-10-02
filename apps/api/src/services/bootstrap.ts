/**
 * First-owner creation on a real database.
 *
 * A fresh production database has no users, `db:seed` refuses to run in
 * production, and the public join flow needs working SMTP for its verification
 * code. This fills that gap: one active clinic (default settings + schedule)
 * and one active owner, nothing else. No sample patients, no demo content.
 *
 * Used from one place, so there is exactly one code path to audit:
 * `scripts/create-owner.mjs`, run by the operator on the server itself.
 * There is deliberately no HTTP endpoint for this: the first account must
 * never be creatable over the network.
 *
 * The refusal rules are the security boundary, not the caller:
 * - any existing user aborts the whole thing, so this can only ever run on an
 *   empty database and a leaked credential is useless after first use;
 * - an existing address aborts, so it can never silently reset a live password.
 */

import { createId, slugify } from '@mediflow/shared';

import { hashPassword, verifyPassword } from '../auth/password.js';
import type { Db } from '../db/index.js';
import { defaultSchedule, defaultSettings } from '../db/defaults.js';
import { jsonColumn } from '../db/mappers.js';

export interface BootstrapInput {
  email: string;
  password: string;
  clinicName?: string;
}

export interface BootstrapResult {
  clinicId: string;
  clinicName: string;
  ownerUserId: string;
  ownerEmail: string;
}

export class BootstrapError extends Error {
  readonly code: 'invalid_email' | 'weak_password' | 'already_bootstrapped' | 'email_taken' | 'verify_failed';
  constructor(code: BootstrapError['code'], message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * Creates the clinic and owner. Throws BootstrapError on any refusal.
 * The password is verified back against the stored hash before returning, so
 * a broken insert surfaces here instead of as a mystery "wrong password".
 */
export async function bootstrapOwner(db: Db, input: BootstrapInput): Promise<BootstrapResult> {
  const email = input.email.toLowerCase().trim();
  const clinicName = input.clinicName?.trim() || 'MediFlow Clinic';

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new BootstrapError('invalid_email', 'That email address is not valid.');
  }
  if (!input.password || input.password.length < 10) {
    // Same 10-character rule as the signup form; a weaker bootstrap password
    // would be the most-attacked account in the system.
    throw new BootstrapError('weak_password', 'Password must be at least 10 characters.');
  }

  const existingUsers = db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number };
  if (existingUsers.n > 0) {
    throw new BootstrapError(
      'already_bootstrapped',
      'This database already has users. Bootstrap only runs on an empty database.',
    );
  }

  return writeClinicOwner(db, email, clinicName, input.password);
}

/**
 * Creates an ADDITIONAL clinic and owner on a database that already has
 * users. Same writes and same verify-back as the first-owner path, minus the
 * empty-database gate. The email must be unused anywhere: one address, one
 * clinic, so a login can never be ambiguous about which practice it opens.
 */
export async function createClinicOwner(db: Db, input: BootstrapInput): Promise<BootstrapResult> {
  const email = input.email.toLowerCase().trim();
  const clinicName = input.clinicName?.trim() || 'MediFlow Clinic';

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new BootstrapError('invalid_email', 'That email address is not valid.');
  }
  if (!input.password || input.password.length < 10) {
    throw new BootstrapError('weak_password', 'Password must be at least 10 characters.');
  }

  const taken = db.prepare('SELECT id FROM users WHERE email = ? LIMIT 1').get(email) as
    | { id: string }
    | undefined;
  if (taken) {
    throw new BootstrapError('email_taken', 'That email already owns a clinic. Each doctor signs in with their own address.');
  }

  return writeClinicOwner(db, email, clinicName, input.password);
}

async function writeClinicOwner(db: Db, email: string, clinicName: string, password: string): Promise<BootstrapResult> {
  let slug = slugify(clinicName, 40);
  // Two clinics may share a name; slugs must stay unique for the URL.
  if ((db.prepare('SELECT id FROM clinics WHERE slug = ?').get(slug) as { id: string } | undefined)) {
    slug = `${slug}-${Math.random().toString(36).slice(2, 7)}`;
  }
  const now = new Date().toISOString();
  const clinicId = createId('clc');
  const ownerUserId = createId('usr');
  const settings = defaultSettings();
  const schedule = defaultSchedule(clinicId, 'ar');
  // Hashed outside the transaction: better-sqlite3 transactions are
  // synchronous, so nothing async may run inside one.
  const passwordHash = await hashPassword(password);

  const write = db.transaction(() => {
    db.prepare(
      `INSERT INTO clinics
         (id, name, name_ar, slug, timezone, country, currency, phone, email, address, logo_url,
          is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    ).run(
      clinicId,
      clinicName,
      clinicName,
      slug,
      'Asia/Beirut',
      'LB',
      'USD',
      null,
      email,
      null,
      null,
      now,
      now,
    );
    db.prepare(
      `INSERT INTO clinic_settings (clinic_id, json, updated_at) VALUES (?, ?, ?)`,
    ).run(clinicId, jsonColumn(settings), now);
    db.prepare(
      `INSERT INTO clinic_schedules (id, clinic_id, json, updated_at) VALUES (?, ?, ?, ?)`,
    ).run(schedule.id, clinicId, jsonColumn(schedule), now);
    db.prepare(
      `INSERT INTO users
         (id, clinic_id, email, password_hash, full_name, full_name_ar, role, phone, locale,
          is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'owner', ?, 'ar', 1, ?, ?)`,
    ).run(ownerUserId, clinicId, email, passwordHash, 'Clinic Owner', 'Clinic Owner', null, now, now);
  });
  write();

  const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(ownerUserId) as
    | { password_hash: string }
    | undefined;
  if (!row || !(await verifyPassword(password, row.password_hash))) {
    throw new BootstrapError('verify_failed', 'Verification of the new account failed; nothing was left half-written.');
  }

  return { clinicId, clinicName, ownerUserId, ownerEmail: email };
}
