/**
 * Firebase identity exchange.
 *
 * Firebase Auth is the identity plane: a doctor signs up with email + password
 * on Firebase, which writes `clinics/{clinicId}` and `users/{uid}` (role +
 * clinicId). This module turns a Firebase ID token into an API session:
 *
 *   1. Verify the ID token against the Firebase project.
 *   2. Read the staff doc for role + clinic. The doc - not the token - is
 *      authoritative for authorisation, so suspending someone is a doc write.
 *   3. Auto-provision the matching clinic and user rows on first login, with
 *      settings and schedule defaults, so a Firebase signup never needs a
 *      second, manual API-side account.
 *   4. Mint the standard API session JWT. Everything downstream (tenant
 *      scoping, capabilities) works exactly as with a password login.
 *
 * The verifier is injectable so tests never touch Google. When Firebase is not
 * configured the exchange endpoint answers 501 rather than failing halfway.
 */

import { cert, getApp, getApps, initializeApp, type App } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { createId, MEMBER_ROLES, type MemberRole } from '@mediflow/shared';

import type { Db } from '../db/index.js';
import { defaultSchedule, defaultSettings } from '../db/defaults.js';
import { jsonColumn } from '../db/mappers.js';
import { signSession, type SessionUser } from './plugin.js';
import type { FastifyInstance } from 'fastify';

export interface FirebaseIdentity {
  uid: string;
  email: string;
}

export interface FirebaseStaffDoc {
  email: string;
  name: string;
  role: string;
  clinicId: string;
}

export class FirebaseNotConfigured extends Error {
  constructor() {
    super('Firebase is not configured on this API (FIREBASE_PROJECT_ID / service account).');
  }
}

export type FirebaseVerifier = (idToken: string) => Promise<FirebaseIdentity>;
export type StaffDocReader = (uid: string) => Promise<FirebaseStaffDoc | null>;

let verifierOverride: FirebaseVerifier | null = null;
let readerOverride: StaffDocReader | null = null;

/** Test seam: replace the Google round-trips with stubs. */
export function setFirebaseTestDoubles(verifier: FirebaseVerifier | null, reader: StaffDocReader | null): void {
  verifierOverride = verifier;
  readerOverride = reader;
}

function adminApp(): App {
  if (getApps().length > 0) return getApp();
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const inline = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  const keyPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
  if (!projectId || (!inline && !keyPath)) {
    throw new FirebaseNotConfigured();
  }
  const credential = inline
    ? cert(JSON.parse(inline) as Parameters<typeof cert>[0])
    : cert(keyPath as string);
  return initializeApp({ credential, projectId });
}

async function defaultVerifier(idToken: string): Promise<FirebaseIdentity> {
  const decoded = await getAuth(adminApp()).verifyIdToken(idToken, true);
  if (!decoded.email) {
    // Password accounts always have an email; anything else (phone, anonymous)
    // has no staff doc to exchange and is rejected, not provisioned.
    throw new Error('This sign-in method has no email and cannot be exchanged.');
  }
  return { uid: decoded.uid, email: decoded.email };
}

async function defaultReader(uid: string): Promise<FirebaseStaffDoc | null> {
  const snap = await getFirestore(adminApp()).doc(`users/${uid}`).get();
  if (!snap.exists) return null;
  const data = snap.data() as Partial<FirebaseStaffDoc> | undefined;
  if (!data?.email || !data?.clinicId) return null;
  return {
    email: data.email,
    name: data.name ?? data.email,
    role: data.role ?? 'doctor',
    clinicId: data.clinicId,
  };
}

function isMemberRole(role: string): role is MemberRole {
  return (MEMBER_ROLES as readonly string[]).includes(role);
}

/**
 * Ensure the clinic row plus its settings/schedule singletons exist.
 * The Firebase clinic id becomes the row id so the mapping is 1:1 forever.
 */
function ensureClinic(db: Db, clinicId: string, name: string, now: string): void {
  const existing = db.prepare('SELECT id FROM clinics WHERE id = ?').get(clinicId) as
    | { id: string }
    | undefined;
  if (existing) return;

  const slugBase = clinicId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  let slug = slugBase || `clinic-${clinicId.slice(0, 8)}`;
  let attempt = 0;
  for (;;) {
    const clash = db.prepare('SELECT id FROM clinics WHERE slug = ?').get(slug) as
      | { id: string }
      | undefined;
    if (!clash) break;
    attempt += 1;
    slug = `${slugBase}-${attempt}`;
  }

  const settings = defaultSettings();
  const schedule = defaultSchedule(clinicId, 'en');
  const write = db.transaction(() => {
    db.prepare(
      `INSERT INTO clinics
         (id, name, name_ar, slug, timezone, country, currency, phone, email, address, logo_url,
          is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'Asia/Riyadh', 'SA', 'SAR', NULL, NULL, NULL, NULL, 1, ?, ?)`,
    ).run(clinicId, name, name, slug, now, now);
    db.prepare(
      `INSERT INTO clinic_settings (clinic_id, json, updated_at) VALUES (?, ?, ?)`,
    ).run(clinicId, jsonColumn(settings), now);
    db.prepare(
      `INSERT INTO clinic_schedules (id, clinic_id, json, updated_at) VALUES (?, ?, ?, ?)`,
    ).run(schedule.id, clinicId, jsonColumn(schedule), now);
  });
  write();
}

export interface FirebaseSession {
  token: string;
  user: SessionUser;
}

/**
 * Exchange a Firebase ID token for an API session, provisioning on first use.
 * Throws FirebaseNotConfigured when the server has no Firebase wiring.
 */
export async function exchangeFirebaseSession(
  app: FastifyInstance,
  db: Db,
  idToken: string,
): Promise<FirebaseSession> {
  const verify = verifierOverride ?? defaultVerifier;
  const readStaff = readerOverride ?? defaultReader;

  const identity = await verify(idToken);
  const staff = await readStaff(identity.uid);
  if (!staff) {
    throw new Error('No staff record on file for this account.');
  }
  if (!isMemberRole(staff.role)) {
    throw new Error('This account has an unknown role and cannot sign in.');
  }

  const now = new Date().toISOString();
  ensureClinic(db, staff.clinicId, `${staff.name}'s clinic`, now);

  let row = db
    .prepare('SELECT id, clinic_id, email, full_name, role, locale, is_active FROM users WHERE firebase_uid = ?')
    .get(identity.uid) as
    | { id: string; clinic_id: string; email: string; full_name: string; role: MemberRole; locale: string; is_active: number }
    | undefined;

  if (!row) {
    // A Firebase user can never password-login: the hash is a locked marker
    // that verifyPassword structurally rejects.
    const id = createId('usr');
    db.prepare(
      `INSERT INTO users
         (id, clinic_id, email, password_hash, full_name, role, locale, firebase_uid,
          is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'en', ?, 1, ?, ?)`,
    ).run(id, staff.clinicId, staff.email, `firebase-only$${identity.uid}`, staff.name, staff.role, identity.uid, now, now);
    row = db
      .prepare('SELECT id, clinic_id, email, full_name, role, locale, is_active FROM users WHERE id = ?')
      .get(id) as typeof row;
  }

  if (!row || row.is_active !== 1) {
    throw new Error('This account is disabled.');
  }
  if (row.clinic_id !== staff.clinicId) {
    // The staff doc moved clinics; follow it rather than stranding the user.
    db.prepare('UPDATE users SET clinic_id = ?, updated_at = ? WHERE id = ?').run(
      staff.clinicId,
      now,
      row.id,
    );
    row = { ...row, clinic_id: staff.clinicId };
  }

  db.prepare('UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?').run(now, now, row.id);

  const user: SessionUser = {
    id: row.id,
    clinicId: row.clinic_id,
    email: row.email,
    fullName: row.full_name,
    role: row.role,
    locale: row.locale,
  };
  return { token: signSession(app, user), user };
}
