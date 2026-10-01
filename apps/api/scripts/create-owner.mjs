/**
 * Create the first owner account on a REAL database.
 *
 *   node apps/api/scripts/create-owner.mjs <email> <password> [clinic-name]
 *
 * `npm run db:seed` deliberately refuses to run in production, and the public
 * join flow needs working SMTP to deliver its verification code. A fresh
 * production database therefore has no way to gain its first login, which is
 * what this script is for. Run it once, from Render Shell, then forget it.
 *
 * It creates exactly one clinic (with default settings + schedule, active),
 * and exactly one owner user (active). No sample patients, no demo content.
 * It refuses to touch an address that already exists: resetting a live
 * password is a different operation and must never happen by accident.
 *
 * DATABASE_FILE is read from the environment, so on Render it automatically
 * targets /data/mediflow.db. Never point this at a database you did not mean
 * to change; it prints the file path before writing anything.
 */

import { createRequire } from 'node:module';
import { createId, slugify } from '@mediflow/shared';

// The API compiles to CommonJS, so its dist modules are pulled in through a
// require hook rather than import. Same code paths as the running server.
const require = createRequire(import.meta.url);
const { openDatabase } = require('../dist/src/db/index.js');
const { hashPassword, verifyPassword } = require('../dist/src/auth/password.js');
const { defaultSchedule, defaultSettings } = require('../dist/src/db/defaults.js');
const { jsonColumn } = require('../dist/src/db/mappers.js');

async function main() {
  const [emailRaw, password, ...nameParts] = process.argv.slice(2);
  const email = (emailRaw ?? '').toLowerCase().trim();
  const clinicName = nameParts.join(' ').trim() || 'MediFlow Clinic';

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    console.error('Usage: node apps/api/scripts/create-owner.mjs <email> <password> [clinic-name]');
    process.exit(2);
  }
  if (!password || password.length < 10) {
    console.error('Refusing: password must be at least 10 characters (same rule as the signup form).');
    process.exit(2);
  }

  const databaseFile = process.env.DATABASE_FILE ?? './data/mediflow.db';
  console.log(`Database: ${databaseFile}`);
  const db = openDatabase({ file: databaseFile });

  try {
    const taken = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (taken) {
      console.error(
        `Refusing: ${email} already exists. This script only creates accounts; ` +
          `use the in-app password reset (or contact the operator) to change one.`,
      );
      process.exit(1);
    }

    const slug = slugify(clinicName, 40);
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

    // Prove the row we just wrote actually authenticates, rather than trusting
    // the insert. A typo'd column list would otherwise surface as "wrong
    // password" at 2am.
    const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(ownerUserId);
    const ok = await verifyPassword(password, row.password_hash);
    console.log(`Self-check: password verifies against the stored hash: ${ok ? 'YES' : 'NO - DO NOT USE THIS ACCOUNT'}`);

    console.log('Created:');
    console.log(`  Clinic: ${clinicName} (${clinicId})`);
    console.log(`  Owner:  ${email} (${ownerUserId})`);
    console.log('Sign in with the password you just passed. Clear the shell history afterwards.');
  } finally {
    db.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
