/**
 * Firebase identity and licence plane.
 *
 * This module is only active when the build carries a Firebase web config
 * (VITE_FIREBASE_* — the dashboard writes one per customer as `.env.<nick>`).
 * Without it the app keeps using the API login, so local development needs no
 * Firebase project at all.
 *
 * Signup registers everything on Firebase, exactly once:
 *   1. Firebase Auth user (email + password).
 *   2. `clinics/{clinicId}` — the clinic profile, owned by the new user.
 *   3. `users/{uid}` — role `owner` + clinicId, which is what the security
 *      rules and the API exchange both read.
 *
 * The API then mints its own session from the Firebase ID token
 * (POST /auth/firebase) and auto-provisions its matching rows, so the doctor
 * signs in once and both planes agree on who they are.
 */

import { initializeApp, type FirebaseApp } from 'firebase/app';
import {
  createUserWithEmailAndPassword,
  getAuth,
  sendEmailVerification,
  signInAnonymously,
  signInWithEmailAndPassword,
  signOut,
  type Auth,
  type User,
} from 'firebase/auth';
import {
  doc,
  getDoc,
  initializeFirestore,
  persistentLocalCache,
  setDoc,
  updateDoc,
  type Firestore,
} from 'firebase/firestore';

export interface FirebaseStatus {
  status?: string;
  message?: string;
}

interface FirebaseEnv {
  apiKey: string;
  authDomain: string;
  projectId: string;
  appId: string;
  storageBucket?: string;
}

function readEnv(): FirebaseEnv | null {
  const env = import.meta.env as Record<string, string | undefined>;
  const apiKey = env.VITE_FIREBASE_API_KEY;
  const authDomain = env.VITE_FIREBASE_AUTH_DOMAIN;
  const projectId = env.VITE_FIREBASE_PROJECT_ID;
  const appId = env.VITE_FIREBASE_APP_ID;
  if (!apiKey || !authDomain || !projectId || !appId) return null;
  const storageBucket = env.VITE_FIREBASE_STORAGE_BUCKET;
  return { apiKey, authDomain, projectId, appId, ...(storageBucket ? { storageBucket } : {}) };
}

let app: FirebaseApp | null = null;
let auth: Auth | null = null;
let db: Firestore | null = null;

export function isFirebaseConfigured(): boolean {
  return readEnv() !== null;
}

function instances(): { auth: Auth; db: Firestore } {
  const env = readEnv();
  if (!env) throw new Error('Firebase is not configured in this build.');
  if (!app) {
    app = initializeApp({
      apiKey: env.apiKey,
      authDomain: env.authDomain,
      projectId: env.projectId,
      appId: env.appId,
    });
    auth = getAuth(app);
    // Offline-first: previously opened lists stay readable with no
    // connectivity, and writes queue locally until the device is back.
    db = initializeFirestore(app, { localCache: persistentLocalCache({}) });
  }
  if (!auth || !db) throw new Error('Firebase failed to initialise.');
  return { auth, db };
}

export function clinicIdFor(email: string): string {
  const slug = email
    .split('@')[0]
    ?.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return `fb-${slug || 'clinic'}`;
}

export interface InviteDoc {
  code: string;
  type: 'clinic' | 'doctor';
  clinicId: string | null;
  note: string | null;
  usedBy: string | null;
  createdAt: string;
}

export async function readInvite(code: string): Promise<InviteDoc | null> {
  const { db } = instances();
  const clean = code.trim().toUpperCase();
  if (!clean) return null;
  const snap = await getDoc(doc(db, 'invites', clean));
  if (!snap.exists()) return null;
  const data = snap.data() as Record<string, unknown>;
  return {
    code: clean,
    type: data['type'] === 'doctor' ? 'doctor' : 'clinic',
    clinicId: typeof data['clinicId'] === 'string' ? (data['clinicId'] as string) : null,
    note: typeof data['note'] === 'string' ? (data['note'] as string) : null,
    usedBy: typeof data['usedBy'] === 'string' ? (data['usedBy'] as string) : null,
    createdAt: typeof data['createdAt'] === 'string' ? (data['createdAt'] as string) : '',
  };
}

/** Clinic signup: activation code first, then Auth user + clinic + owner doc. */
export async function signUpDoctor(input: {
  name: string;
  email: string;
  password: string;
  clinicName: string;
  activationCode: string;
}): Promise<User> {
  const { auth, db } = instances();
  const invite = await readInvite(input.activationCode);
  if (!invite || invite.type !== 'clinic') {
    throw new Error('activation');
  }
  let user: User;
  try {
    const credential = await createUserWithEmailAndPassword(auth, input.email, input.password);
    user = credential.user;
  } catch (error) {
    // A previous attempt may have created the Auth account before failing on
    // the Firestore writes. Sign in with the same credentials and resume
    // below instead of stranding the address behind "email already in use".
    if ((error as { code?: string }).code === 'auth/email-already-in-use') {
      const credential = await signInWithEmailAndPassword(auth, input.email, input.password);
      user = credential.user;
    } else {
      throw error;
    }
  }
  // Re-read after sign-in: a code burned by someone else in the meantime must
  // still refuse, but a code burned by MY earlier attempt resumes below.
  const fresh = await readInvite(input.activationCode);
  if (!fresh || fresh.type !== 'clinic' || (fresh.usedBy && fresh.usedBy !== user.uid)) {
    throw new Error('activation');
  }
  // The inbox proves the address before anything trusts it.
  await sendEmailVerification(user).catch(() => undefined);
  const clinicId = clinicIdFor(input.email);
  const now = new Date().toISOString();

  // Resume-safe: every write targets a deterministic id, so re-running
  // completes a half-finished signup instead of duplicating it.
  const existing = await getDoc(doc(db, 'users', user.uid));
  if (!existing.exists()) {
    await setDoc(doc(db, 'clinics', clinicId), {
      name: input.clinicName,
      nameAr: null,
      slug: clinicId,
      timezone: 'Asia/Beirut',
      currency: 'USD',
      doctorLimit: 1,
      plan: 'standard',
      subscribedAt: now,
      expiresAt: null,
      disabled: false,
      activationCode: invite.code,
      ownerUid: user.uid,
      createdAt: now,
    });
    // The rules validate the code from THIS field - a doc without it can
    // never satisfy the owner branch, which bricked every signup.
    await setDoc(doc(db, 'users', user.uid), {
      uid: user.uid,
      email: input.email,
      name: input.name,
      role: 'owner',
      clinicId,
      status: 'pending',
      disabled: false,
      activationCode: invite.code,
      createdAt: now,
    });
    // Burn the code so it cannot register a second practice.
    await updateDoc(doc(db, 'invites', invite.code), { usedBy: user.uid, usedAt: now }).catch(() => undefined);
  }
  return user;
}

/** Doctor signup: redeems a clinic invite, joins as pending doctor. */
export async function signUpDoctorWithInvite(input: {
  name: string;
  email: string;
  password: string;
  inviteCode: string;
}): Promise<User> {
  const { auth, db } = instances();
  const invite = await readInvite(input.inviteCode);
  if (!invite || invite.type !== 'doctor' || !invite.clinicId) {
    throw new Error('invite');
  }
  let user: User;
  try {
    const credential = await createUserWithEmailAndPassword(auth, input.email, input.password);
    user = credential.user;
  } catch (error) {
    // Same resume path as clinic signup: a half-finished attempt leaves an
    // Auth account behind, so sign in and complete the Firestore docs.
    if ((error as { code?: string }).code === 'auth/email-already-in-use') {
      const credential = await signInWithEmailAndPassword(auth, input.email, input.password);
      user = credential.user;
    } else {
      throw error;
    }
  }
  const fresh = await readInvite(input.inviteCode);
  if (!fresh || fresh.type !== 'doctor' || !fresh.clinicId || (fresh.usedBy && fresh.usedBy !== user.uid)) {
    throw new Error('invite');
  }
  await sendEmailVerification(user).catch(() => undefined);
  const now = new Date().toISOString();
  const existing = await getDoc(doc(db, 'users', user.uid));
  if (!existing.exists()) {
    await setDoc(doc(db, 'users', user.uid), {
      uid: user.uid,
      email: input.email,
      name: input.name,
      role: 'doctor',
      clinicId: invite.clinicId,
      status: 'pending',
      disabled: false,
      inviteCode: invite.code,
      createdAt: now,
    });
    await updateDoc(doc(db, 'invites', invite.code), { usedBy: user.uid, usedAt: now }).catch(() => undefined);
  }
  return user;
}

export interface ClinicDoc {
  id: string;
  name: string;
  disabled: boolean;
  doctorLimit: number;
  plan: string | null;
  subscribedAt: string | null;
  expiresAt: string | null;
}

export async function readClinicDoc(clinicId: string): Promise<ClinicDoc | null> {
  const { db } = instances();
  const snap = await getDoc(doc(db, 'clinics', clinicId));
  if (!snap.exists()) return null;
  const data = snap.data() as Record<string, unknown>;
  return {
    id: clinicId,
    name: typeof data['name'] === 'string' ? (data['name'] as string) : clinicId,
    disabled: data['disabled'] === true,
    doctorLimit: typeof data['doctorLimit'] === 'number' ? data['doctorLimit'] : 1,
    plan: typeof data['plan'] === 'string' ? (data['plan'] as string) : null,
    subscribedAt: typeof data['subscribedAt'] === 'string' ? (data['subscribedAt'] as string) : null,
    expiresAt: typeof data['expiresAt'] === 'string' ? (data['expiresAt'] as string) : null,
  };
}

export async function signInDoctor(email: string, password: string): Promise<User> {
  const { auth } = instances();
  const credential = await signInWithEmailAndPassword(auth, email, password);
  return credential.user;
}

export async function signOutDoctor(): Promise<void> {
  const { auth } = instances();
  await signOut(auth);
}

export async function firebaseIdToken(): Promise<string> {
  const { auth } = instances();
  const user = auth.currentUser;
  if (!user) throw new Error('Not signed in.');
  return user.getIdToken();
}

/** Reload + verified flag: unverified accounts wait at the gate. */
export async function isEmailVerified(): Promise<boolean> {
  const { auth } = instances();
  const user = auth.currentUser;
  if (!user) return false;
  await user.reload();
  return auth.currentUser?.emailVerified === true;
}

export async function resendVerification(): Promise<void> {
  const { auth } = instances();
  const user = auth.currentUser;
  if (!user) throw new Error('Not signed in.');
  await sendEmailVerification(user);
}

/** Current Firebase user, waiting for Auth to initialise first. */
export async function firebaseUser(): Promise<User | null> {
  const { auth } = instances();
  await auth.authStateReady();
  return auth.currentUser;
}

/**
 * Anonymous session for the patient app: no credentials, no personal data in
 * Auth. Authorization rides on unguessable patient-account ids (capability
 * model), so anonymous is sufficient - rules never trust the uid itself.
 * Requires the Anonymous provider enabled on the project (one toggle).
 */
export async function ensureAnonymous(): Promise<User> {
  const { auth } = instances();
  await auth.authStateReady();
  if (auth.currentUser) return auth.currentUser;
  const cred = await signInAnonymously(auth);
  return cred.user;
}

/** Firestore handle for the data layer (same initialised instance). */
export function getFirestoreInstance(): Firestore {
  return instances().db;
}

/** Firebase app handle (for Storage and other lazy SDKs). */
export function getFirebaseApp(): FirebaseApp {
  const env = readEnv();
  if (!env) throw new Error('Firebase is not configured in this build.');
  instances();
  if (!app) throw new Error('Firebase failed to initialise.');
  return app;
}

/** Configured storage bucket, or null when this build has none. */
export function storageBucket(): string | null {
  return readEnv()?.storageBucket ?? null;
}

/** Licence kill-switch, same pattern as the POS fleet. Suspended = locked UI. */
export async function readAppStatus(): Promise<FirebaseStatus> {
  const { db } = instances();
  const snap = await getDoc(doc(db, 'config', 'appStatus'));
  if (!snap.exists()) return { status: 'active' };
  return snap.data() as FirebaseStatus;
}

export interface StaffDoc {
  uid: string;
  email: string;
  name: string;
  role: string;
  clinicId: string;
  status?: string;
  disabled?: boolean;
  isReseller?: boolean;
  /** Trial/test accounts: skip the email-verification gate (reseller sets it). */
  trial?: boolean;
}

export async function readStaffDoc(uid: string): Promise<StaffDoc | null> {
  const { db } = instances();
  const snap = await getDoc(doc(db, 'users', uid));
  if (!snap.exists()) return null;
  return snap.data() as StaffDoc;
}

const RESELLER_KEY = 'mf_reseller';
const ROLE_KEY = 'mf_role';

/** Sync check for nav guards: set at login/boot from the staff doc. */
export function isResellerCached(): boolean {
  try {
    return localStorage.getItem(RESELLER_KEY) === '1';
  } catch {
    return false;
  }
}

/** Cached staff role (owner/doctor/...) for owner-only UI. Empty when unknown. */
export function cachedRole(): string {
  try {
    return localStorage.getItem(ROLE_KEY) ?? '';
  } catch {
    return '';
  }
}

export function clearResellerFlag(): void {
  try {
    localStorage.removeItem(RESELLER_KEY);
    localStorage.removeItem(ROLE_KEY);
  } catch {
    // Storage failures must never block sign-out.
  }
}

/**
 * Refresh the cached reseller flag from the staff doc. Called at login and
 * at boot; the flag is what unlocks the Admin console without an API session.
 */
export async function refreshResellerFlag(): Promise<boolean> {
  try {
    const user = await firebaseUser();
    if (!user) {
      clearResellerFlag();
      return false;
    }
    const staff = await readStaffDoc(user.uid);
    const reseller = staff?.isReseller === true;
    try {
      localStorage.setItem(RESELLER_KEY, reseller ? '1' : '0');
      if (staff?.role) localStorage.setItem(ROLE_KEY, staff.role);
    } catch {
      // Ignore storage pressure here; the console just stays hidden.
    }
    return reseller;
  } catch {
    return isResellerCached();
  }
}
