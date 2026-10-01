/**
 * Development seed.
 *
 * Creates one clinic with an owner account, a default schedule, and settings.
 * Idempotent: running it twice updates the clinic rather than failing, so it
 * is safe to call on every boot in development.
 *
 * The owner password is deliberately obvious and the account is refused in
 * production by `seed()`.
 */

import { createId, formatMrn, slugify } from '@mediflow/shared';

import type { Db } from './index.js';
import { defaultSchedule, defaultSettings } from './defaults.js';
import { jsonColumn } from './mappers.js';
import { hashPassword } from '../auth/password.js';

export interface SeedOptions {
  clinicName?: string;
  clinicNameAr?: string;
  ownerEmail?: string;
  ownerPassword?: string;
  ownerName?: string;
  timezone?: string;
  currency?: string;
  locale?: 'en' | 'ar';
  /** Refuse to seed when true. */
  isProduction?: boolean;
}

export interface SeedResult {
  clinicId: string;
  ownerUserId: string;
  ownerEmail: string;
  created: boolean;
}

export async function seed(db: Db, options: SeedOptions = {}): Promise<SeedResult> {
  if (options.isProduction) {
    throw new Error('Refusing to run the development seed in production.');
  }

  const clinicName = options.clinicName ?? 'MediFlow Demo Clinic';
  const ownerEmail = (options.ownerEmail ?? 'owner@mediflow.test').toLowerCase().trim();
  const ownerPassword = options.ownerPassword ?? 'ChangeMe!2026';
  const ownerName = options.ownerName ?? 'Clinic Owner';
  const timezone = options.timezone ?? 'Asia/Riyadh';
  const currency = options.currency ?? 'SAR';
  const locale = options.locale ?? 'en';

  const slug = slugify(clinicName, 40);
  const existing = db.prepare('SELECT id FROM clinics WHERE slug = ?').get(slug) as
    | { id: string }
    | undefined;

  const now = new Date().toISOString();
  const clinicId = existing?.id ?? createId('clc');
  const settings = defaultSettings();
  const schedule = defaultSchedule(clinicId, locale);

  const write = db.transaction(() => {
    if (existing) {
      db.prepare(
        `UPDATE clinics SET name = ?, name_ar = ?, timezone = ?, currency = ?, updated_at = ? WHERE id = ?`,
      ).run(clinicName, options.clinicNameAr ?? clinicName, timezone, currency, now, clinicId);
    } else {
      db.prepare(
        `INSERT INTO clinics
           (id, name, name_ar, slug, timezone, country, currency, phone, email, address, logo_url,
            is_active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      ).run(
        clinicId,
        clinicName,
        options.clinicNameAr ?? clinicName,
        slug,
        timezone,
        'SA',
        currency,
        null,
        null,
        null,
        null,
        now,
        now,
      );
    }

    // Settings and schedule are single-row-per-clinic, keyed by clinic id.
    db.prepare(
      `INSERT INTO clinic_settings (clinic_id, json, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(clinic_id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`,
    ).run(clinicId, jsonColumn(settings), now);

    db.prepare(
      `INSERT INTO clinic_schedules (id, clinic_id, json, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`,
    ).run(schedule.id, clinicId, jsonColumn(schedule), now);
  });
  write();

  // The owner may already exist from a previous seed; only hash when creating.
  const existingUser = db
    .prepare('SELECT id FROM users WHERE clinic_id = ? AND email = ?')
    .get(clinicId, ownerEmail) as { id: string } | undefined;

  const ownerUserId = existingUser?.id ?? createId('usr');
  if (!existingUser) {
    const passwordHash = await hashPassword(ownerPassword);
    db.prepare(
      `INSERT INTO users
         (id, clinic_id, email, password_hash, full_name, full_name_ar, role, phone, locale,
          is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'owner', ?, ?, 1, ?, ?)`,
    ).run(
      ownerUserId,
      clinicId,
      ownerEmail,
      passwordHash,
      ownerName,
      locale === 'ar' ? ownerName : null,
      null,
      locale,
      now,
      now,
    );
  }

  return { clinicId, ownerUserId, ownerEmail, created: !existing };
}

/** A handful of patients, so the UI is not empty on first run. */
export async function seedPatients(db: Db, clinicId: string, count = 8): Promise<string[]> {
  const now = new Date().toISOString();
  const names = [
    ['Sara', 'Al-Harbi', 'female'],
    ['Omar', 'Khalil', 'male'],
    ['Nadia', 'Farouk', 'female'],
    ['Yusuf', 'Nasser', 'male'],
    ['Layla', 'Mansour', 'female'],
    ['Tariq', 'Idrissi', 'male'],
    ['Hana', 'Saleh', 'female'],
    ['Bilal', 'Aziz', 'male'],
  ] as const;

  const ids: string[] = [];
  const insert = db.transaction(() => {
    for (let i = 0; i < Math.min(count, names.length); i += 1) {
      const [first, last, sex] = names[i] as (typeof names)[number];
      const id = createId('pat');
      const mrn = formatMrn('MRN', i + 1);
      const fullName = `${first} ${last}`;
      const phone = `+9665${String(10000000 + i * 111111).slice(0, 8)}`;
      db.prepare(
        `INSERT INTO patients
           (id, clinic_id, mrn, first_name, last_name, full_name, phone, whatsapp_number, sex,
            preferred_language, whatsapp_opt_in, whatsapp_opt_in_at, search_blob, source, is_active,
            balance_minor, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'en', 1, ?, ?, 'staff', 1, 0, ?, ?)`,
      ).run(
        id,
        clinicId,
        mrn,
        first,
        last,
        fullName,
        phone,
        phone,
        sex,
        now,
        `${fullName} ${phone} ${mrn}`.toLowerCase(),
        now,
        now,
      );
      ids.push(id);
    }
  });
  insert();
  return ids;
}
