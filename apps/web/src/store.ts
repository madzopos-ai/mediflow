/**
 * Firestore data layer — the clinical backend for customer builds.
 *
 * One Firebase project per clinic. All clinical collections live under
 * `clinics/{clinicId}/…`, and `firestore.rules` restricts every read and
 * write to members of that clinic with a clinical staff role.
 *
 * Domain invariants that Firestore rules cannot express run client-side with
 * the same shared library as the API: overlap checks, MRN sequencing (via an
 * atomic counter transaction), money in minor units, and critical-vital
 * alerts. Offline works through Firestore's persistent cache — previously
 * opened data stays readable and writes sync when the device is back.
 */

import {
  addDoc,
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  runTransaction,
  setDoc,
  updateDoc,
  where,
} from 'firebase/firestore';
import {
  addDaysToDateKey,
  checkDrugInteractions,
  createId,
  createToken,
  dateKeyInTz,
  emptyClinicalContext,
  estimateEgfr,
  evaluateVital,
  formatMrn,
  generateSlots,
  recommendLabGuidedDoses,
  recommendLifestyle,
  runRuleBasedDecisionSupport,
  sortInteractions,
  todayInTz,
  vitalUnit,
  weekdayOfDateKey,
  zonedTimeToUtc,
  type VitalKind,
} from '@mediflow/shared';

import { firebaseUser, readStaffDoc } from './firebase.js';
import { getLang } from './i18n.js';
import type { Firestore } from 'firebase/firestore';

export interface ClinicSession {
  uid: string;
  email: string;
  name: string;
  role: string;
  clinicId: string;
}

let dbRef: Firestore | null = null;

async function context(): Promise<{ db: Firestore; session: ClinicSession }> {
  const user = await firebaseUser();
  if (!user) throw new Error('Not signed in.');
  const staff = await readStaffDoc(user.uid);
  if (!staff) throw new Error('No staff record on file for this account.');
  const { getFirestoreInstance } = await import('./firebase.js');
  const db = getFirestoreInstance();
  dbRef = db;
  return {
    db,
    session: {
      uid: staff.uid,
      email: staff.email,
      name: staff.name,
      role: staff.role,
      clinicId: staff.clinicId,
    },
  };
}

function col(db: Firestore, clinicId: string, name: string) {
  return collection(db, 'clinics', clinicId, name);
}

export function cachedDb(): Firestore | null {
  return dbRef;
}

// ---------------------------------------------------------------------------
// Reseller console (Firebase mode): pending practices + clinic list.
// Single-field queries only, so no composite index is ever required.
// ---------------------------------------------------------------------------

export interface PendingUserDoc {
  uid: string;
  name: string;
  email: string;
  clinicId: string;
  createdAt: string | null;
}

export interface ClinicSummaryDoc {
  id: string;
  name: string;
  ownerUid: string | null;
  createdAt: string | null;
}

async function resellerDb(): Promise<Firestore> {
  const user = await firebaseUser();
  if (!user) throw new Error('Not signed in.');
  const { getFirestoreInstance } = await import('./firebase.js');
  return getFirestoreInstance();
}

export async function listPendingUsers(): Promise<PendingUserDoc[]> {
  const db = await resellerDb();
  const snap = await getDocs(query(collection(db, 'users'), where('status', '==', 'pending'), limit(100)));
  return snap.docs.map((d) => {
    const data = d.data() as Record<string, unknown>;
    return {
      uid: d.id,
      name: String(data['name'] ?? ''),
      email: String(data['email'] ?? ''),
      clinicId: String(data['clinicId'] ?? ''),
      createdAt: typeof data['createdAt'] === 'string' ? (data['createdAt'] as string) : null,
    };
  });
}

export async function approveUser(uid: string): Promise<void> {
  const db = await resellerDb();
  await updateDoc(doc(db, 'users', uid), { status: 'active', updatedAt: new Date().toISOString() });
}

export async function listAllClinics(): Promise<ClinicSummaryDoc[]> {
  const db = await resellerDb();
  const snap = await getDocs(query(collection(db, 'clinics'), limit(100)));
  return snap.docs.map((d) => {
    const data = d.data() as Record<string, unknown>;
    return {
      id: d.id,
      name: String(data['name'] ?? d.id),
      ownerUid: typeof data['ownerUid'] === 'string' ? (data['ownerUid'] as string) : null,
      createdAt: typeof data['createdAt'] === 'string' ? (data['createdAt'] as string) : null,
    };
  });
}

// ---------------------------------------------------------------------------
// Reseller billing: activation codes, subscriptions, collections, disables.
// ---------------------------------------------------------------------------

export interface ActivationCode {
  code: string;
  note: string | null;
  usedBy: string | null;
  createdAt: string;
}

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function randomCode(length = 8): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

export async function listActivationCodes(): Promise<ActivationCode[]> {
  const db = await resellerDb();
  const snap = await getDocs(query(collection(db, 'invites'), orderBy('createdAt', 'desc'), limit(200)));
  return snap.docs
    .map((d) => {
      const data = d.data() as Record<string, unknown>;
      if (data['type'] !== 'clinic') return null;
      return {
        code: d.id,
        note: typeof data['note'] === 'string' ? (data['note'] as string) : null,
        usedBy: typeof data['usedBy'] === 'string' ? (data['usedBy'] as string) : null,
        createdAt: typeof data['createdAt'] === 'string' ? (data['createdAt'] as string) : '',
      };
    })
    .filter((c): c is ActivationCode => c !== null);
}

export async function createActivationCode(note: string | null): Promise<string> {
  const db = await resellerDb();
  const code = randomCode();
  await setDoc(doc(db, 'invites', code), {
    code,
    type: 'clinic',
    clinicId: null,
    note,
    createdAt: new Date().toISOString(),
  });
  return code;
}

export async function revokeActivationCode(code: string): Promise<void> {
  const db = await resellerDb();
  const { deleteDoc } = await import('firebase/firestore');
  await deleteDoc(doc(db, 'invites', code));
}

export interface ClinicStaffRow {
  uid: string;
  name: string;
  email: string;
  role: string;
  status: string;
  disabled: boolean;
}

export async function clinicStaff(clinicId: string): Promise<ClinicStaffRow[]> {
  const db = await resellerDb();
  const snap = await getDocs(query(collection(db, 'users'), where('clinicId', '==', clinicId), limit(100)));
  return snap.docs.map((d) => {
    const data = d.data() as Record<string, unknown>;
    return {
      uid: d.id,
      name: typeof data['name'] === 'string' ? (data['name'] as string) : '',
      email: typeof data['email'] === 'string' ? (data['email'] as string) : '',
      role: typeof data['role'] === 'string' ? (data['role'] as string) : '',
      status: typeof data['status'] === 'string' ? (data['status'] as string) : '',
      disabled: data['disabled'] === true,
    };
  });
}

export interface ClinicSubscription {
  plan: string | null;
  pricePerDoctorMinor: number;
  currency: string;
  doctorLimit: number;
  subscribedAt: string | null;
  expiresAt: string | null;
  disabled: boolean;
}

export async function readClinicSubscription(clinicId: string): Promise<ClinicSubscription> {
  const db = await resellerDb();
  const snap = await getDoc(doc(db, 'clinics', clinicId));
  const data = (snap.data() ?? {}) as Record<string, unknown>;
  return {
    plan: typeof data['plan'] === 'string' ? (data['plan'] as string) : null,
    pricePerDoctorMinor: typeof data['pricePerDoctorMinor'] === 'number' ? data['pricePerDoctorMinor'] : 0,
    currency: typeof data['currency'] === 'string' ? (data['currency'] as string) : 'USD',
    doctorLimit: typeof data['doctorLimit'] === 'number' ? data['doctorLimit'] : 1,
    subscribedAt: typeof data['subscribedAt'] === 'string' ? (data['subscribedAt'] as string) : null,
    expiresAt: typeof data['expiresAt'] === 'string' ? (data['expiresAt'] as string) : null,
    disabled: data['disabled'] === true,
  };
}

export async function saveClinicSubscription(
  clinicId: string,
  patch: {
    plan: string | null;
    pricePerDoctorMinor: number;
    currency: string;
    doctorLimit: number;
    subscribedAt: string | null;
    expiresAt: string | null;
  },
): Promise<void> {
  const db = await resellerDb();
  if (!Number.isInteger(patch.pricePerDoctorMinor) || patch.pricePerDoctorMinor < 0) {
    throw new Error('Price must be whole minor units (cents).');
  }
  if (!Number.isInteger(patch.doctorLimit) || patch.doctorLimit < 1) {
    throw new Error('Doctor limit must be at least 1.');
  }
  await updateDoc(doc(db, 'clinics', clinicId), {
    plan: patch.plan,
    pricePerDoctorMinor: patch.pricePerDoctorMinor,
    currency: patch.currency,
    doctorLimit: patch.doctorLimit,
    subscribedAt: patch.subscribedAt,
    expiresAt: patch.expiresAt,
    updatedAt: new Date().toISOString(),
  });
}

export interface SubscriptionReceipt {
  id: string;
  amountMinor: number;
  currency: string;
  doctorId: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  reference: string | null;
  note: string | null;
  receivedAt: string;
}

export async function recordSubscriptionPayment(
  clinicId: string,
  input: {
    amountMinor: number;
    currency: string;
    doctorId: string | null;
    periodStart: string | null;
    periodEnd: string | null;
    reference: string | null;
    note: string | null;
  },
): Promise<void> {
  const db = await resellerDb();
  if (!Number.isInteger(input.amountMinor) || input.amountMinor <= 0) {
    throw new Error('Amount must be positive whole minor units.');
  }
  const now = new Date().toISOString();
  const ref = doc(collection(db, 'clinics', clinicId, 'subscriptionPayments'));
  await setDoc(ref, { ...input, receivedAt: now, createdAt: now });
}

export async function clinicSubscriptionPayments(clinicId: string): Promise<SubscriptionReceipt[]> {
  const db = await resellerDb();
  const snap = await getDocs(
    query(collection(db, 'clinics', clinicId, 'subscriptionPayments'), orderBy('receivedAt', 'desc'), limit(100)),
  );
  return snap.docs.map((d) => {
    const data = d.data() as Record<string, unknown>;
    return {
      id: d.id,
      amountMinor: typeof data['amountMinor'] === 'number' ? data['amountMinor'] : 0,
      currency: typeof data['currency'] === 'string' ? (data['currency'] as string) : '',
      doctorId: typeof data['doctorId'] === 'string' ? (data['doctorId'] as string) : null,
      periodStart: typeof data['periodStart'] === 'string' ? (data['periodStart'] as string) : null,
      periodEnd: typeof data['periodEnd'] === 'string' ? (data['periodEnd'] as string) : null,
      reference: typeof data['reference'] === 'string' ? (data['reference'] as string) : null,
      note: typeof data['note'] === 'string' ? (data['note'] as string) : null,
      receivedAt: typeof data['receivedAt'] === 'string' ? (data['receivedAt'] as string) : '',
    };
  });
}

/**
 * Disable (or re-enable) a practice. Disabling deletes the public directory
 * card, so the clinic vanishes from every patient screen immediately;
 * clinical data is untouched. Re-enabling restores the card on next staff
 * save (or republish it here is out of scope - staff save republishes).
 */
export async function setClinicDisabled(clinicId: string, disabled: boolean): Promise<void> {
  const db = await resellerDb();
  const now = new Date().toISOString();
  await updateDoc(doc(db, 'clinics', clinicId), { disabled, updatedAt: now });
  if (disabled) {
    const { deleteDoc } = await import('firebase/firestore');
    await deleteDoc(doc(db, 'publicClinics', clinicId)).catch(() => undefined);
  }
}

export async function setUserDisabled(uid: string, disabled: boolean): Promise<void> {
  const db = await resellerDb();
  await updateDoc(doc(db, 'users', uid), { disabled, updatedAt: new Date().toISOString() });
  if (disabled) {
    const { deleteDoc } = await import('firebase/firestore');
    await deleteDoc(doc(db, 'publicDoctors', uid)).catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Clinic profile (timezone for slot math)
// ---------------------------------------------------------------------------

let timezoneCache: { clinicId: string; timeZone: string } | null = null;
let currencyCache: { clinicId: string; currency: string } | null = null;

export async function clinicTimeZone(clinicId: string): Promise<string> {
  if (timezoneCache?.clinicId === clinicId) return timezoneCache.timeZone;
  const { db } = await context();
  const snap = await getDoc(doc(db, 'clinics', clinicId));
  const timeZone = (snap.data()?.['timezone'] as string | undefined) ?? 'Asia/Riyadh';
  timezoneCache = { clinicId, timeZone };
  return timeZone;
}

export async function clinicCurrency(clinicId: string): Promise<string> {
  if (currencyCache?.clinicId === clinicId) return currencyCache.currency;
  const { db } = await context();
  const snap = await getDoc(doc(db, 'clinics', clinicId));
  const currency = (snap.data()?.['currency'] as string | undefined) ?? 'USD';
  currencyCache = { clinicId, currency };
  return currency;
}

export async function clinicDisplayName(clinicId: string): Promise<string> {  const { db } = await context();
  const snap = await getDoc(doc(db, 'clinics', clinicId));
  const data = snap.data() as Record<string, unknown> | undefined;
  const nameAr = data?.['nameAr'];
  const name = data?.['name'];
  if (typeof nameAr === 'string' && nameAr.trim() !== '') return nameAr;
  if (typeof name === 'string' && name.trim() !== '') return name;
  return clinicId;
}

export async function clinicLocation(): Promise<{ lat: number; lng: number } | null> {
  const { db, session } = await context();
  const snap = await getDoc(doc(db, 'clinics', session.clinicId));
  const loc = (snap.data() as Record<string, unknown> | undefined)?.['location'] as
    | { lat?: unknown; lng?: unknown }
    | undefined;
  if (typeof loc?.lat === 'number' && typeof loc?.lng === 'number') return { lat: loc.lat, lng: loc.lng };
  return null;
}

// ---------------------------------------------------------------------------
// Public directory + booking requests (Firebase patient app).
// ---------------------------------------------------------------------------

/** Publish this clinic's public card (name/phone/address) for the directory. */
export async function syncPublicClinic(): Promise<void> {
  const { db, session } = await context();
  const snap = await getDoc(doc(db, 'clinics', session.clinicId));
  const data = (snap.data() ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);
  const location = data['location'] as { lat?: unknown; lng?: unknown } | undefined;
  const lat = typeof location?.lat === 'number' ? location.lat : null;
  const lng = typeof location?.lng === 'number' ? location.lng : null;
  const hoursRaw = data['workingHours'];
  const workingHours = Array.isArray(hoursRaw)
    ? (hoursRaw as Record<string, unknown>[])
        .filter((d) => typeof d === 'object' && d !== null)
        .map((d) => ({
          weekday: typeof d['weekday'] === 'number' ? d['weekday'] : -1,
          enabled: d['enabled'] === true,
          start: typeof d['start'] === 'string' ? (d['start'] as string) : '',
          end: typeof d['end'] === 'string' ? (d['end'] as string) : '',
          ...(typeof d['start2'] === 'string' && d['start2'] !== '' ? { start2: d['start2'] as string } : {}),
          ...(typeof d['end2'] === 'string' && d['end2'] !== '' ? { end2: d['end2'] as string } : {}),
        }))
        .filter((d) => d.weekday >= 0 && d.weekday <= 6)
    : null;
  const num = (v: unknown, fallback: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  const slotDurationMinutes = num(data['slotDurationMinutes'], 30);
  const visitRaw = data['visitDurations'] as Record<string, unknown> | undefined;
  const visitDurations =
    visitRaw && typeof visitRaw === 'object'
      ? {
          consultation: num(visitRaw['consultation'], slotDurationMinutes),
          follow_up: num(visitRaw['follow_up'], slotDurationMinutes),
          procedure: num(visitRaw['procedure'], slotDurationMinutes),
          teleconsult: num(visitRaw['teleconsult'], slotDurationMinutes),
        }
      : null;
  const remRaw = data['reminderSettings'] as Record<string, unknown> | undefined;
  const reminderSettings =
    remRaw && typeof remRaw === 'object'
      ? {
          remind24h: remRaw['remind24h'] !== false,
          remind3d: remRaw['remind3d'] !== false,
          medsReminders: remRaw['medsReminders'] !== false,
          bookingConfirm: remRaw['bookingConfirm'] !== false,
        }
      : null;
  await setDoc(doc(db, 'publicClinics', session.clinicId), {
    clinicId: session.clinicId,
    name: str(data['name']) ?? session.clinicId,
    nameAr: str(data['nameAr']),
    phone: str(data['phone']),
    address: str(data['address']),
    ...(lat !== null && lng !== null ? { location: { lat, lng } } : {}),
    ...(workingHours ? { workingHours } : {}),
    slotDurationMinutes,
    ...(visitDurations ? { visitDurations } : {}),
    ...(reminderSettings ? { reminderSettings } : {}),
    updatedAt: new Date().toISOString(),
  });
}

/** Clinic working hours for the directory (owner-only by rules). Two shifts per day: morning + evening. */
export interface WorkingDay {
  weekday: number;
  enabled: boolean;
  start: string;
  end: string;
  start2?: string | null;
  end2?: string | null;
}

export interface BookingSettings {
  slotDurationMinutes: number;
  visitDurations: { consultation: number; follow_up: number; procedure: number; teleconsult: number };
  reminderSettings: { remind24h: boolean; remind3d: boolean; medsReminders: boolean; bookingConfirm: boolean };
}

const DEFAULT_BOOKING_SETTINGS: BookingSettings = {
  slotDurationMinutes: 30,
  visitDurations: { consultation: 30, follow_up: 15, procedure: 60, teleconsult: 20 },
  reminderSettings: { remind24h: true, remind3d: false, medsReminders: true, bookingConfirm: true },
};

export async function myBookingSettings(): Promise<BookingSettings> {
  const { db, session } = await context();
  const snap = await getDoc(doc(db, 'clinics', session.clinicId));
  const data = (snap.data() ?? {}) as Record<string, unknown>;
  const num = (v: unknown, fallback: number): number =>
    typeof v === 'number' && Number.isFinite(v) && v >= 5 && v <= 480 ? v : fallback;
  const slot = num(data['slotDurationMinutes'], DEFAULT_BOOKING_SETTINGS.slotDurationMinutes);
  const raw = (data['visitDurations'] ?? {}) as Record<string, unknown>;
  const rem = (data['reminderSettings'] ?? {}) as Record<string, unknown>;
  return {
    slotDurationMinutes: slot,
    visitDurations: {
      consultation: num(raw['consultation'], slot),
      follow_up: num(raw['follow_up'], Math.min(slot, 15)),
      procedure: num(raw['procedure'], Math.max(slot, 60)),
      teleconsult: num(raw['teleconsult'], Math.min(slot, 20)),
    },
    reminderSettings: {
      remind24h: rem['remind24h'] !== false,
      remind3d: rem['remind3d'] === true,
      medsReminders: rem['medsReminders'] !== false,
      bookingConfirm: rem['bookingConfirm'] !== false,
    },
  };
}

export async function saveBookingSettings(input: BookingSettings): Promise<void> {
  const { db, session } = await context();
  const num = (v: number): number => {
    if (!Number.isFinite(v) || v < 5 || v > 480) throw new Error('Slot minutes must be 5-480.');
    return Math.round(v);
  };
  const payload = {
    slotDurationMinutes: num(input.slotDurationMinutes),
    visitDurations: {
      consultation: num(input.visitDurations.consultation),
      follow_up: num(input.visitDurations.follow_up),
      procedure: num(input.visitDurations.procedure),
      teleconsult: num(input.visitDurations.teleconsult),
    },
    reminderSettings: { ...input.reminderSettings },
    updatedAt: new Date().toISOString(),
  };
  await updateDoc(doc(db, 'clinics', session.clinicId), payload);
  await syncPublicClinic();
}

export async function myWorkingHours(): Promise<WorkingDay[] | null> {
  const { db, session } = await context();
  const snap = await getDoc(doc(db, 'clinics', session.clinicId));
  const raw = (snap.data() as Record<string, unknown> | undefined)?.['workingHours'];
  if (!Array.isArray(raw)) return null;
  return (raw as Record<string, unknown>[]).map((d) => ({
    weekday: typeof d['weekday'] === 'number' ? d['weekday'] : -1,
    enabled: d['enabled'] === true,
    start: typeof d['start'] === 'string' ? (d['start'] as string) : '',
    end: typeof d['end'] === 'string' ? (d['end'] as string) : '',
    start2: typeof d['start2'] === 'string' ? (d['start2'] as string) : null,
    end2: typeof d['end2'] === 'string' ? (d['end2'] as string) : null,
  }));
}

export async function saveMyWorkingHours(days: WorkingDay[]): Promise<void> {
  const { db, session } = await context();
  const timeOk = (v: string | null | undefined, optional: boolean): boolean => {
    if ((v === null || v === undefined || v === '') && optional) return true;
    return typeof v === 'string' && /^\d{2}:\d{2}$/.test(v);
  };
  for (const d of days) {
    if (!Number.isInteger(d.weekday) || d.weekday < 0 || d.weekday > 6) throw new Error('Bad weekday.');
    if (d.enabled && !/^\d{2}:\d{2}$/.test(d.start)) throw new Error('Bad start time.');
    if (d.enabled && !/^\d{2}:\d{2}$/.test(d.end)) throw new Error('Bad end time.');
    if (!timeOk(d.start2, true)) throw new Error('Bad evening start.');
    if (!timeOk(d.end2, true)) throw new Error('Bad evening end.');
  }
  await updateDoc(doc(db, 'clinics', session.clinicId), {
    workingHours: days,
    updatedAt: new Date().toISOString(),
  });
  await syncPublicClinic();
}

/** Publish/update my own doctor card (called at staff login/boot). */
export async function syncMyDirectoryEntry(): Promise<void> {
  const { db, session } = await context();
  const me = await getDoc(doc(db, 'users', session.uid));
  const mine = (me.data() ?? {}) as Record<string, unknown>;
  const now = new Date().toISOString();
  // Merge, never overwrite: a previously uploaded photo survives re-syncs.
  await setDoc(
    doc(db, 'publicDoctors', session.uid),
    {
      name: session.name,
      clinicId: session.clinicId,
      clinicName: await clinicDisplayName(session.clinicId),
      role: session.role,
      specialty: typeof mine['specialty'] === 'string' ? (mine['specialty'] as string) : null,
      phone: typeof mine['phone'] === 'string' ? (mine['phone'] as string) : null,
      updatedAt: now,
    },
    { merge: true },
  );
}

/** Doctor sets their own directory specialty + booking phone. */
export async function saveMyDirectoryDetails(input: { specialty: string | null; phone: string | null }): Promise<void> {
  const { db, session } = await context();
  const now = new Date().toISOString();
  await updateDoc(doc(db, 'users', session.uid), {
    specialty: input.specialty,
    phone: input.phone,
    updatedAt: now,
  });
  await setDoc(
    doc(db, 'publicDoctors', session.uid),
    {
      name: session.name,
      clinicId: session.clinicId,
      clinicName: await clinicDisplayName(session.clinicId),
      role: session.role,
      specialty: input.specialty,
      phone: input.phone,
      updatedAt: now,
    },
    { merge: true },
  );
}

export interface MyDirectoryEntry {
  name: string;
  avatarUrl: string | null;
  clinicId: string;
  clinicName: string;
  specialty: string | null;
  phone: string | null;
}

export async function getMyDirectoryEntry(): Promise<MyDirectoryEntry | null> {
  const { db, session } = await context();
  const snap = await getDoc(doc(db, 'publicDoctors', session.uid));
  if (!snap.exists()) {
    return { name: session.name, avatarUrl: null, clinicId: session.clinicId, clinicName: '', specialty: null, phone: null };
  }
  const data = snap.data() as Record<string, unknown>;
  return {
    name: typeof data['name'] === 'string' ? (data['name'] as string) : session.name,
    avatarUrl: typeof data['avatarUrl'] === 'string' ? (data['avatarUrl'] as string) : null,
    clinicId: session.clinicId,
    clinicName: typeof data['clinicName'] === 'string' ? (data['clinicName'] as string) : '',
    specialty: typeof data['specialty'] === 'string' ? (data['specialty'] as string) : null,
    phone: typeof data['phone'] === 'string' ? (data['phone'] as string) : null,
  };
}

/** Shrink to a web-friendly JPEG data URL (no Storage bucket needed). */
function resizeToDataUrl(file: Blob, maxSide = 256): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      try {
        const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(img.width * scale));
        canvas.height = Math.max(1, Math.round(img.height * scale));
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('Canvas unavailable.');
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        URL.revokeObjectURL(url);
        resolve(canvas.toDataURL('image/jpeg', 0.8));
      } catch (error) {
        URL.revokeObjectURL(url);
        reject(error);
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Could not read the photo.'));
    };
    img.src = url;
  });
}

/**
 * Set my directory photo: resized client-side and stored on my public card
 * (~15-30 KB). No Storage bucket, no extra rules, loads instantly.
 */
export async function uploadMyDirectoryPhoto(file: Blob): Promise<string> {
  const { db, session } = await context();
  if (!file.type.startsWith('image/')) throw new Error('Choose an image file.');
  if (file.size > 8 * 1024 * 1024) throw new Error('Photo must be under 8 MB.');
  const dataUrl = await resizeToDataUrl(file);
  await setDoc(
    doc(db, 'publicDoctors', session.uid),
    { avatarUrl: dataUrl, updatedAt: new Date().toISOString() },
    { merge: true },
  );
  return dataUrl;
}

/** Save the clinic pin (owner-only by rules) + republish the public card. */
export async function saveClinicLocation(lat: number, lng: number): Promise<void> {
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) throw new Error('Invalid latitude.');
  if (!Number.isFinite(lng) || lng < -180 || lng > 180) throw new Error('Invalid longitude.');
  const { db, session } = await context();
  const now = new Date().toISOString();
  await updateDoc(doc(db, 'clinics', session.clinicId), {
    location: { lat, lng },
    updatedAt: now,
  });
  await syncPublicClinic();
}

export interface BookingRequestDoc {
  id: string;
  patientAccountId: string;
  patientName: string;
  phone: string;
  preferredDate: string;
  startsAt: string | null;
  note: string | null;
  status: 'requested' | 'accepted' | 'declined';
  createdAt: string;
}

function toBookingRequest(id: string, data: Record<string, unknown>): BookingRequestDoc {
  const status = String(data['status'] ?? 'requested');
  return {
    id,
    patientAccountId: String(data['patientAccountId'] ?? ''),
    patientName: String(data['patientName'] ?? ''),
    phone: String(data['phone'] ?? ''),
    preferredDate: String(data['preferredDate'] ?? ''),
    startsAt: typeof data['startsAt'] === 'string' ? (data['startsAt'] as string) : null,
    note: typeof data['note'] === 'string' ? (data['note'] as string) : null,
    status: status === 'accepted' || status === 'declined' ? status : 'requested',
    createdAt: String(data['createdAt'] ?? ''),
  };
}

export async function listBookingRequests(): Promise<BookingRequestDoc[]> {
  const { db, session } = await context();
  const snap = await getDocs(
    query(collection(db, 'bookingRequests', session.clinicId, 'items'), orderBy('createdAt', 'desc'), limit(100)),
  );
  return snap.docs
    .map((d) => toBookingRequest(d.id, d.data() as Record<string, unknown>))
    .filter((r) => r.status === 'requested');
}

async function findPatientByPhoneExact(phone: string): Promise<PatientDoc | null> {
  const { db, session } = await context();
  const snap = await getDocs(query(col(db, session.clinicId, 'patients'), where('phone', '==', phone), limit(5)));
  const first = snap.docs[0];
  return first ? toPatient(first.id, first.data() as Record<string, unknown>) : null;
}

/**
 * Accept a booking request: find-or-create the local patient by phone, book
 * the chosen slot, auto-link the patient app account, mark accepted.
 */
export async function acceptBookingRequest(requestId: string, startsAt: string): Promise<string> {
  const { db, session } = await context();
  const ref = doc(db, 'bookingRequests', session.clinicId, 'items', requestId);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error('Booking request not found.');
  const req = toBookingRequest(requestId, snap.data() as Record<string, unknown>);
  if (req.status !== 'requested') throw new Error('Request already handled.');

  let patient = await findPatientByPhoneExact(req.phone);
  if (!patient) {
    const parts = req.patientName.trim().split(/\s+/);
    const firstName = parts[0] ?? req.patientName;
    const lastName = parts.slice(1).join(' ') || '—';
    const now = new Date().toISOString();
    const mrn = await runTransaction(db, async (tx) => {
      const counterRef = doc(db, 'clinics', session.clinicId, 'counters', 'mrn');
      const counter = await tx.get(counterRef);
      const seq = ((counter.data()?.['seq'] as number | undefined) ?? 0) + 1;
      tx.set(counterRef, { seq }, { merge: true });
      return formatMrn('MRN', seq);
    });
    const created = await addDoc(col(db, session.clinicId, 'patients'), {
      fullName: req.patientName,
      firstName,
      lastName,
      phone: req.phone,
      whatsappNumber: req.phone,
      mrn,
      sex: 'unknown',
      preferredLanguage: 'en',
      whatsappOptIn: true,
      whatsappOptInAt: now,
      dateOfBirth: null,
      ageYears: null,
      heightCm: null,
      weightKg: null,
      address: null,
      city: null,
      insurerId: null,
      insurerPolicyNo: null,
      chronicConditions: [],
      allergies: [],
      currentMedications: [],
      search: `${req.patientName} ${req.phone} ${mrn}`.toLowerCase(),
      createdAt: now,
      updatedAt: now,
    });
    const fresh = await getDoc(created);
    patient = toPatient(created.id, (fresh.data() ?? {}) as Record<string, unknown>);
  }

  const start = new Date(startsAt).getTime();
  if (Number.isNaN(start)) throw new Error('Invalid start time.');
  await assertBookableTime(startsAt);
  const end = start + APPT_DURATION_MINUTES * 60_000;
  const dayKey = new Date(start).toISOString().slice(0, 10);
  const existing = await listAppointments(dayKey, dayKey);
  const clash = existing.some(
    (a) =>
      a.status !== 'cancelled' &&
      a.status !== 'no_show' &&
      start < new Date(a.endsAt).getTime() &&
      new Date(a.startsAt).getTime() < end,
  );
  if (clash) throw new Error('That time is not available.');
  const direct = await listDirectBookings().catch(() => [] as DirectBookingDoc[]);
  const directClash = direct.some(
    (d) =>
      d.status === 'confirmed' &&
      start < new Date(d.endsAt).getTime() &&
      new Date(d.startsAt).getTime() < end,
  );
  if (directClash) throw new Error('That time is not available.');
  const now = new Date().toISOString();
  await addDoc(col(db, session.clinicId, 'appointments'), {
    patientId: patient.id,
    patientName: patient.fullName,
    patientPhone: patient.phone,
    startsAt: new Date(start).toISOString(),
    endsAt: new Date(end).toISOString(),
    timezone: await clinicTimeZone(session.clinicId),
    status: 'confirmed',
    doctorName: null,
    confirmationToken: createToken(24),
    source: 'patient_request',
    createdAt: now,
    updatedAt: now,
  });
  // Auto-link so snapshots + WhatsApp tasks work for this patient at once.
  await updateDoc(doc(db, 'clinics', session.clinicId, 'patients', patient.id), {
    patientAppId: req.patientAccountId,
    updatedAt: now,
  });
  await updateDoc(doc(db, 'patientAccounts', req.patientAccountId), {
    [`links.${session.clinicId}`]: { patientId: patient.id, linkedAt: now },
    updatedAt: now,
  });
  await updateDoc(ref, { status: 'accepted', updatedAt: now });
  return patient.fullName;
}

export async function declineBookingRequest(requestId: string): Promise<void> {
  const { db, session } = await context();
  const ref = doc(db, 'bookingRequests', session.clinicId, 'items', requestId);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error('Booking request not found.');
  await updateDoc(ref, { status: 'declined', updatedAt: new Date().toISOString() });
}

export interface DirectBookingDoc {
  id: string;
  patientAccountId: string;
  patientName: string;
  phone: string;
  startsAt: string;
  endsAt: string;
  visitType: string;
  doctorName: string;
  note: string | null;
  status: 'confirmed' | 'cancelled' | 'rescheduled';
  createdAt: string;
}

function toDirectBooking(id: string, data: Record<string, unknown>): DirectBookingDoc {
  const st = String(data['status'] ?? 'confirmed');
  return {
    id,
    patientAccountId: String(data['patientAccountId'] ?? ''),
    patientName: String(data['patientName'] ?? ''),
    phone: String(data['phone'] ?? ''),
    startsAt: String(data['startsAt'] ?? ''),
    endsAt: String(data['endsAt'] ?? String(data['startsAt'] ?? '')),
    visitType: String(data['visitType'] ?? 'consultation'),
    doctorName: String(data['doctorName'] ?? ''),
    note: typeof data['note'] === 'string' ? (data['note'] as string) : null,
    status: st === 'cancelled' || st === 'rescheduled' ? st : 'confirmed',
    createdAt: String(data['createdAt'] ?? ''),
  };
}

/** Staff view of instant patient bookings (confirmed slots). */
export async function listDirectBookings(): Promise<DirectBookingDoc[]> {
  const { db, session } = await context();
  const snap = await getDocs(
    query(collection(db, 'directBookings', session.clinicId, 'items'), orderBy('startsAt', 'asc'), limit(200)),
  );
  return snap.docs.map((d) => toDirectBooking(d.id, d.data() as Record<string, unknown>));
}

/** Staff cancels a direct booking: frees the slot + mirrors to patient file. */
export async function cancelDirectBooking(bookingId: string): Promise<void> {
  const { db, session } = await context();
  const ref = doc(db, 'directBookings', session.clinicId, 'items', bookingId);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error('Booking not found.');
  const data = snap.data() as Record<string, unknown>;
  const now = new Date().toISOString();
  await updateDoc(ref, { status: 'cancelled', updatedAt: now });
  const accountId = typeof data['patientAccountId'] === 'string' ? (data['patientAccountId'] as string) : '';
  if (accountId) {
    await updateDoc(doc(db, 'patientAccounts', accountId, 'bookings', bookingId), {
      status: 'cancelled',
      updatedAt: now,
    }).catch(() => undefined);
  }
  const { deleteDoc } = await import('firebase/firestore');
  await deleteDoc(doc(db, 'slotClaims', session.clinicId, 'items', bookingId)).catch(() => undefined);
  await publishAvailability().catch(() => undefined);
}

/**
 * Publish next-14-days free slots for patients. Computed on staff devices
 * from the real working hours + live bookings, so no slot math ever trusts
 * the patient's browser. Best-effort and idempotent: call it on calendar
 * load and after every booking change. A stale snapshot can never
 * double-book - accept revalidates the chosen slot transactionally.
 */
export async function publishAvailability(): Promise<number> {
  const { db, session } = await context();
  const now = new Date().toISOString();
  const timeZone = await clinicTimeZone(session.clinicId);
  const clinicSnap = await getDoc(doc(db, 'clinics', session.clinicId));
  const clinicData = (clinicSnap.data() ?? {}) as Record<string, unknown>;
  const rawHours = clinicData['workingHours'];
  if (!Array.isArray(rawHours)) return 0;
  const today = todayInTz(timeZone, new Date(now));
  const slotNum = (v: unknown, fallback: number): number =>
    typeof v === 'number' && Number.isFinite(v) && v >= 5 && v <= 480 ? Math.round(v) : fallback;
  const slotDuration = slotNum(clinicData['slotDurationMinutes'], 30);
  const windowsFor = (d: Record<string, unknown>): { start: string; end: string }[] => {
    const out: { start: string; end: string }[] = [];
    const s1 = typeof d['start'] === 'string' ? d['start'] : '';
    const e1 = typeof d['end'] === 'string' ? d['end'] : '';
    if (/^\d{2}:\d{2}$/.test(s1) && /^\d{2}:\d{2}$/.test(e1) && e1 > s1) out.push({ start: s1, end: e1 });
    const s2 = typeof d['start2'] === 'string' ? d['start2'] : '';
    const e2 = typeof d['end2'] === 'string' ? d['end2'] : '';
    if (/^\d{2}:\d{2}$/.test(s2) && /^\d{2}:\d{2}$/.test(e2) && e2 > s2) out.push({ start: s2, end: e2 });
    return out;
  };
  const baseDays = (rawHours as Record<string, unknown>[])
    .filter((d) => typeof d === 'object' && d !== null)
    .map((d) => ({
      weekday: typeof d['weekday'] === 'number' ? d['weekday'] : -1,
      enabled: d['enabled'] === true,
      windows: windowsFor(d),
    }))
    .filter((d) => d.weekday >= 0 && d.weekday <= 6 && d.enabled && d.windows.length > 0);
  // generateSlots supports one window per weekday; expand two shifts into two
  // pseudo-schedules merged per day so morning + evening both publish.
  const scheduleBase = {
    id: 'live',
    clinicId: session.clinicId,
    slotDurationMinutes: slotDuration,
    slotIntervalMinutes: slotDuration,
    bufferMinutes: 0,
    maxDailyAppointments: null,
    holidays: [],
    blockedWindows: [],
    allowWalkIn: true,
    createdAt: now,
    updatedAt: now,
  };
  const from = today;
  const to = addDaysToDateKey(today, 13);
  const existing = await listAppointments(from, to);
  const busyAppt = existing
    .filter((a) => a.status !== 'cancelled' && a.status !== 'no_show' && a.status !== 'rescheduled')
    .map((a) => ({ start: new Date(a.startsAt).getTime(), end: new Date(a.endsAt).getTime() }));
  // Direct patient bookings + pending requests holding a slot also block it,
  // otherwise two patients pick the same free chip before next publish.
  const busyExtra: { start: number; end: number }[] = [];
  try {
    const directSnap = await getDocs(
      query(collection(db, 'directBookings', session.clinicId, 'items'), where('status', '==', 'confirmed'), limit(200)),
    );
    for (const docSnap of directSnap.docs) {
      const dd = docSnap.data() as Record<string, unknown>;
      const s = typeof dd['startsAt'] === 'string' ? Date.parse(dd['startsAt'] as string) : NaN;
      const e = typeof dd['endsAt'] === 'string' ? Date.parse(dd['endsAt'] as string) : NaN;
      if (Number.isFinite(s)) busyExtra.push({ start: s, end: Number.isFinite(e) ? e : s + slotDuration * 60_000 });
    }
  } catch {
    // Best-effort: appointments alone still prevent most double-books.
  }
  try {
    const reqSnap = await getDocs(
      query(collection(db, 'bookingRequests', session.clinicId, 'items'), where('status', '==', 'requested'), limit(200)),
    );
    for (const docSnap of reqSnap.docs) {
      const dd = docSnap.data() as Record<string, unknown>;
      const s = typeof dd['startsAt'] === 'string' ? Date.parse(dd['startsAt'] as string) : NaN;
      if (Number.isFinite(s)) busyExtra.push({ start: s, end: s + slotDuration * 60_000 });
    }
  } catch {
    // Ignore.
  }
  const busy = [...busyAppt, ...busyExtra];
  const { deleteDoc } = await import('firebase/firestore');
  let published = 0;
  for (let offset = -7; offset < 14; offset += 1) {
    const day = addDaysToDateKey(today, offset);
    const dayRef = doc(db, 'publicSlots', session.clinicId, 'days', day);
    if (offset < 0) {
      await deleteDoc(dayRef).catch(() => undefined);
      continue;
    }
    const dayDef = baseDays.find((d) => weekdayOfDateKey(day) === d.weekday);
    // Fallback: match by schedule weekday using shared helper when available.
    const allSlots: { startsAt: string; endsAt: string; localStart: string }[] = [];
    if (dayDef) {
      for (const w of dayDef.windows) {
        const schedule = {
          ...scheduleBase,
          workingHours: [{ weekday: dayDef.weekday, enabled: true, start: w.start, end: w.end, breaks: [] }],
        };
        const generated = generateSlots({ schedule, timeZone, dateKey: day, durationMinutes: slotDuration, earliestUtc: now });
        for (const s of generated) allSlots.push(s);
      }
    } else {
      // No hours for this weekday: publish empty day so patients see closure.
      await setDoc(dayRef, { dateKey: day, slots: [], updatedAt: now });
      continue;
    }
    allSlots.sort((a, b) => (a.startsAt < b.startsAt ? -1 : 1));
    const free = allSlots.filter((s) => {
      const start = new Date(s.startsAt).getTime();
      const end = new Date(s.endsAt).getTime();
      return !busy.some((b) => start < b.end && b.start < end);
    });
    await setDoc(dayRef, {
      dateKey: day,
      slots: free.map((s) => ({ startsAt: s.startsAt, localStart: s.localStart })),
      updatedAt: now,
    });
    published += free.length;
  }
  return published;
}

// ---------------------------------------------------------------------------
// Patients
// ---------------------------------------------------------------------------

export interface PatientDoc {
  id: string;
  fullName: string;
  firstName: string;
  lastName: string;
  phone: string;
  whatsappNumber: string | null;
  mrn: string;
  sex: string;
  preferredLanguage: string;
  whatsappOptIn: boolean;
  ageYears: number | null;
  dateOfBirth: string | null;
  heightCm: number | null;
  weightKg: number | null;
  address: string | null;
  city: string | null;
  chronicConditions: string[];
  allergies: string[];
  currentMedications: string[];
  insurerId: string | null;
  insurerPolicyNo: string | null;
  /** Firebase patient-app account linked by ticket (null until linked). */
  patientAppId: string | null;
  createdAt: string;
}

function toPatient(id: string, data: Record<string, unknown>): PatientDoc {
  const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
  const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);
  const nulStr = (v: unknown): string | null => (typeof v === 'string' ? v : null);
  const arr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  return {
    id,
    fullName: str(data['fullName'], id),
    firstName: str(data['firstName']),
    lastName: str(data['lastName']),
    phone: str(data['phone']),
    whatsappNumber: typeof data['whatsappNumber'] === 'string' ? (data['whatsappNumber'] as string) : null,
    mrn: str(data['mrn']),
    sex: str(data['sex'], 'unknown'),
    preferredLanguage: str(data['preferredLanguage'], 'en'),
    whatsappOptIn: data['whatsappOptIn'] !== false,
    ageYears: num(data['ageYears']),
    dateOfBirth: nulStr(data['dateOfBirth']),
    heightCm: num(data['heightCm']),
    weightKg: num(data['weightKg']),
    address: nulStr(data['address']),
    city: nulStr(data['city']),
    chronicConditions: arr(data['chronicConditions']),
    allergies: arr(data['allergies']),
    currentMedications: arr(data['currentMedications']),
    insurerId: nulStr(data['insurerId']),
    insurerPolicyNo: nulStr(data['insurerPolicyNo']),
    patientAppId: nulStr(data['patientAppId']),
    createdAt: str(data['createdAt']),
  };
}

export async function listPatients(search: string): Promise<PatientDoc[]> {
  const { db, session } = await context();
  const snap = await getDocs(query(col(db, session.clinicId, 'patients'), orderBy('fullName'), limit(100)));
  const q = search.trim().toLowerCase();
  return snap.docs
    .map((d) => toPatient(d.id, d.data() as Record<string, unknown>))
    .filter(
      (p) =>
        q === '' ||
        p.fullName.toLowerCase().includes(q) ||
        p.phone.includes(q) ||
        p.mrn.toLowerCase().includes(q),
    );
}

export async function createPatient(input: {
  firstName: string;
  lastName: string;
  phone: string;
  dateOfBirth: string;
  address: string;
  heightCm: number;
  weightKg: number;
  insurerId?: string | null;
  insurerPolicyNo?: string | null;
}): Promise<string> {
  const { db, session } = await context();
  const fullName = `${input.firstName.trim()} ${input.lastName.trim()}`.trim();
  if (!fullName) throw new Error('Name is required.');
  const phone = input.phone.trim();
  if (!phone) throw new Error('Phone is required.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.dateOfBirth)) throw new Error('Date of birth must be yyyy-mm-dd.');
  if (input.address.trim().length < 2) throw new Error('Address is required.');
  if (input.insurerId && !input.insurerPolicyNo?.trim()) {
    throw new Error('An insurance policy number is required with an insurer.');
  }
  const now = new Date().toISOString();

  const birth = new Date(`${input.dateOfBirth}T00:00:00Z`).getTime();
  const ageYears = Math.floor((Date.now() - birth) / (365.25 * 86_400_000));

  // Atomic MRN sequence: the counter transaction is what makes two receptionists
  // adding a patient at the same moment receive different numbers.
  const mrn = await runTransaction(db, async (tx) => {
    const counterRef = doc(db, 'clinics', session.clinicId, 'counters', 'mrn');
    const snap = await tx.get(counterRef);
    const seq = ((snap.data()?.['seq'] as number | undefined) ?? 0) + 1;
    tx.set(counterRef, { seq }, { merge: true });
    return formatMrn('MRN', seq);
  });

  const ref = await addDoc(col(db, session.clinicId, 'patients'), {
    fullName,
    firstName: input.firstName.trim(),
    lastName: input.lastName.trim(),
    phone,
    whatsappNumber: phone,
    mrn,
    sex: 'unknown',
    preferredLanguage: 'en',
    whatsappOptIn: true,
    whatsappOptInAt: now,
    dateOfBirth: input.dateOfBirth,
    ageYears,
    heightCm: input.heightCm,
    weightKg: input.weightKg,
    address: input.address.trim(),
    city: null,
    insurerId: input.insurerId ?? null,
    insurerPolicyNo: input.insurerPolicyNo?.trim() || null,
    chronicConditions: [],
    allergies: [],
    currentMedications: [],
    searchBlob: `${fullName} ${phone} ${mrn}`.toLowerCase(),
    createdAt: now,
    updatedAt: now,
  });
  return ref.id;
}

export async function updatePatient(
  id: string,
  input: {
    firstName?: string;
    lastName?: string;
    phone?: string;
    dateOfBirth?: string | null;
    heightCm?: number | null;
    weightKg?: number | null;
    address?: string | null;
    city?: string | null;
    insurerId?: string | null;
    insurerPolicyNo?: string | null;
  },
): Promise<void> {
  const { db, session } = await context();
  const values: Record<string, unknown> = { updatedAt: new Date().toISOString() };
  if (input.firstName !== undefined) values['firstName'] = input.firstName.trim();
  if (input.lastName !== undefined) values['lastName'] = input.lastName.trim();
  if (input.phone !== undefined) values['phone'] = input.phone.trim();
  if (input.dateOfBirth !== undefined) {
    values['dateOfBirth'] = input.dateOfBirth;
    if (input.dateOfBirth) {
      const birth = new Date(`${input.dateOfBirth}T00:00:00Z`).getTime();
      values['ageYears'] = Math.floor((Date.now() - birth) / (365.25 * 86_400_000));
    }
  }
  if (input.heightCm !== undefined) values['heightCm'] = input.heightCm;
  if (input.weightKg !== undefined) values['weightKg'] = input.weightKg;
  if (input.address !== undefined) values['address'] = input.address;
  if (input.city !== undefined) values['city'] = input.city;
  if (input.insurerId !== undefined) values['insurerId'] = input.insurerId;
  if (input.insurerPolicyNo !== undefined) values['insurerPolicyNo'] = input.insurerPolicyNo;
  if (Object.keys(values).length === 1) return;
  // Same rule as the API: the resulting link must carry a policy number.
  const current = await getPatient(id);
  const effectiveInsurer = input.insurerId !== undefined ? input.insurerId : (current?.insurerId ?? null);
  const effectivePolicy =
    input.insurerPolicyNo !== undefined ? input.insurerPolicyNo : (current?.insurerPolicyNo ?? null);
  if (effectiveInsurer && !effectivePolicy) {
    throw new Error('An insurance policy number is required with an insurer.');
  }
  const first = String(values['firstName'] ?? '');
  const last = String(values['lastName'] ?? '');
  if (first || last) {
    const current = await getPatient(id);
    values['fullName'] = `${first || current?.firstName || ''} ${last || current?.lastName || ''}`.trim();
  }
  await updateDoc(doc(db, 'clinics', session.clinicId, 'patients', id), values);
}

export async function getPatient(id: string): Promise<PatientDoc | null> {
  const { db, session } = await context();
  const snap = await getDoc(doc(db, 'clinics', session.clinicId, 'patients', id));
  if (!snap.exists()) return null;
  return toPatient(snap.id, snap.data() as Record<string, unknown>);
}

export async function setPatientConsent(id: string, optIn: boolean): Promise<void> {
  const { db, session } = await context();
  const now = new Date().toISOString();
  await updateDoc(doc(db, 'clinics', session.clinicId, 'patients', id), {
    whatsappOptIn: optIn,
    whatsappOptInAt: optIn ? now : null,
    updatedAt: now,
  });
}

// ---------------------------------------------------------------------------
// Vitals (+ critical alerts, mirroring the API behaviour)
// ---------------------------------------------------------------------------

export interface VitalDoc {
  id: string;
  kind: string;
  value: number;
  unit: string;
  measuredAt: string;
}

export async function recordVital(patientId: string, kind: string, value: number): Promise<{ critical: boolean }> {
  const { db, session } = await context();
  const now = new Date().toISOString();
  const unit = vitalUnit(kind as VitalKind);
  await addDoc(col(db, session.clinicId, 'vitals'), {
    patientId,
    kind,
    value,
    unit,
    measuredAt: now,
    createdAt: now,
  });

  // A critical reading creates an alert for a human. It is never auto-resolved,
  // and nothing here prescribes or diagnoses.
  const evaluation = evaluateVital({ kind: kind as VitalKind, value });
  if (evaluation.isCritical) {
    const patient = await getPatient(patientId);
    await addDoc(col(db, session.clinicId, 'alerts'), {
      patientId,
      kind: 'critical_reading',
      severity: 'critical',
      status: 'open',
      title: `Critical ${kind}: ${String(value)} ${unit}`,
      body: evaluation.interpretation,
      patientName: patient?.fullName ?? patientId,
      createdAt: now,
      updatedAt: now,
    });
  }
  return { critical: evaluation.isCritical };
}

export async function latestVitals(patientId: string, max = 20): Promise<VitalDoc[]> {
  const { db, session } = await context();
  const snap = await getDocs(
    query(col(db, session.clinicId, 'vitals'), where('patientId', '==', patientId), orderBy('measuredAt', 'desc'), limit(max)),
  );
  return snap.docs.map((d) => {
    const data = d.data() as Record<string, unknown>;
    return {
      id: d.id,
      kind: String(data['kind'] ?? ''),
      value: Number(data['value'] ?? 0),
      unit: String(data['unit'] ?? ''),
      measuredAt: String(data['measuredAt'] ?? ''),
    };
  });
}

// ---------------------------------------------------------------------------
// Appointments
// ---------------------------------------------------------------------------

export interface AppointmentDoc {
  id: string;
  patientId: string | null;
  patientName: string;
  patientPhone: string;
  startsAt: string;
  endsAt: string;
  status: string;
  doctorName: string | null;
  confirmationToken: string;
}

const APPT_DURATION_MINUTES = 30;

function toAppointment(id: string, data: Record<string, unknown>): AppointmentDoc {
  return {
    id,
    patientId: typeof data['patientId'] === 'string' ? (data['patientId'] as string) : null,
    patientName: String(data['patientName'] ?? ''),
    patientPhone: String(data['patientPhone'] ?? ''),
    startsAt: String(data['startsAt'] ?? ''),
    endsAt: String(data['endsAt'] ?? ''),
    status: String(data['status'] ?? 'scheduled'),
    doctorName: typeof data['doctorName'] === 'string' ? (data['doctorName'] as string) : null,
    confirmationToken: String(data['confirmationToken'] ?? ''),
  };
}

function dayBounds(dateKey: string, timeZone: string): { lo: string; hi: string } {
  return {
    lo: zonedTimeToUtc(dateKey, '00:00', timeZone).toISOString(),
    hi: zonedTimeToUtc(addDaysToDateKey(dateKey, 1), '00:00', timeZone).toISOString(),
  };
}

/** Clinic-local "HH:mm" for an instant (booking validation, labels). */
function localHmInTz(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(instant);
  const hour = parts.find((p) => p.type === 'hour')?.value ?? '00';
  const minute = parts.find((p) => p.type === 'minute')?.value ?? '00';
  return `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`;
}

/**
 * Staff-side time guard: no past bookings, and no 4 AM bookings — the start
 * must sit inside the clinic's own morning/evening shifts. Runs before every
 * staff write (book, accept, reschedule) so the calendar can never hold an
 * off-hours appointment no matter which button created it.
 */
async function assertBookableTime(startsAt: string): Promise<void> {
  const start = new Date(startsAt).getTime();
  if (!Number.isFinite(start)) throw new Error('Invalid start time.');
  if (start < Date.now() - 60_000) throw new Error('لا يمكن الحجز بتاريخ ماضي.');
  const { db, session } = await context();
  const clinicSnap = await getDoc(doc(db, 'clinics', session.clinicId));
  const data = (clinicSnap.data() ?? {}) as Record<string, unknown>;
  const timeZone = typeof data['timezone'] === 'string' && data['timezone'] ? (data['timezone'] as string) : 'Asia/Beirut';
  const rawHours = data['workingHours'];
  if (!Array.isArray(rawHours)) return;
  const instant = new Date(start);
  const weekday = weekdayOfDateKey(dateKeyInTz(instant, timeZone));
  const hm = localHmInTz(instant, timeZone);
  const def = (rawHours as Record<string, unknown>[]).find(
    (d) => typeof d === 'object' && d !== null && d['weekday'] === weekday && d['enabled'] === true,
  );
  const inside = (s: unknown, e: unknown): boolean =>
    typeof s === 'string' &&
    typeof e === 'string' &&
    /^\d{2}:\d{2}$/.test(s) &&
    /^\d{2}:\d{2}$/.test(e) &&
    s <= hm &&
    hm < e;
  const ok =
    !!def &&
    (inside(def['start'], def['end']) ||
      (typeof def['start2'] === 'string' &&
        def['start2'] !== '' &&
        inside(def['start2'], def['end2'])));
  if (!ok) throw new Error('الوقت خارج الدوام — اختار وقت ضمن دوام العيادة.');
}

export async function listAppointments(fromKey: string, toKey: string): Promise<AppointmentDoc[]> {
  const { db, session } = await context();
  const timeZone = await clinicTimeZone(session.clinicId);
  const lo = dayBounds(fromKey, timeZone).lo;
  const hi = dayBounds(toKey, timeZone).hi;
  const snap = await getDocs(
    query(
      col(db, session.clinicId, 'appointments'),
      where('startsAt', '>=', lo),
      where('startsAt', '<', hi),
      orderBy('startsAt', 'asc'),
      limit(200),
    ),
  );
  return snap.docs.map((d) => toAppointment(d.id, d.data() as Record<string, unknown>));
}

export async function bookAppointment(input: {
  patientId?: string | null;
  patientName: string;
  patientPhone: string;
  startsAt: string;
}): Promise<AppointmentDoc> {
  const { db, session } = await context();
  const start = new Date(input.startsAt).getTime();
  if (Number.isNaN(start)) throw new Error('Invalid start time.');
  await assertBookableTime(input.startsAt);
  const end = start + APPT_DURATION_MINUTES * 60_000;

  // Same guarantee as the API transaction: no two live appointments overlap.
  // Firestore has no cross-doc unique constraint for ranges, so the check runs
  // against the day's live rows immediately before the write — including
  // patient instant bookings, which hold their slots just the same.
  const dayKey = new Date(start).toISOString().slice(0, 10);
  const existing = await listAppointments(dayKey, dayKey);
  const clash = existing.some(
    (a) =>
      a.status !== 'cancelled' &&
      a.status !== 'no_show' &&
      start < new Date(a.endsAt).getTime() &&
      new Date(a.startsAt).getTime() < end,
  );
  if (clash) throw new Error('That time is not available.');
  const direct = await listDirectBookings().catch(() => [] as DirectBookingDoc[]);
  const directClash = direct.some(
    (d) =>
      d.status === 'confirmed' &&
      start < new Date(d.endsAt).getTime() &&
      new Date(d.startsAt).getTime() < end,
  );
  if (directClash) throw new Error('That time is not available.');

  const now = new Date().toISOString();
  const ref = await addDoc(col(db, session.clinicId, 'appointments'), {
    patientId: input.patientId ?? null,
    patientName: input.patientName,
    patientPhone: input.patientPhone,
    startsAt: new Date(start).toISOString(),
    endsAt: new Date(end).toISOString(),
    timezone: await clinicTimeZone(session.clinicId),
    status: 'scheduled',
    doctorName: null,
    confirmationToken: createToken(24),
    source: 'staff',
    createdAt: now,
    updatedAt: now,
  });
  const snap = await getDoc(ref);
  return toAppointment(ref.id, (snap.data() ?? {}) as Record<string, unknown>);
}

export interface DayBusy {
  startsAt: string;
  endsAt: string;
  patientName: string;
  kind: 'appointment' | 'direct';
}

export interface DayFree {
  startsAt: string;
  endsAt: string;
  localStart: string;
}

/**
 * One day through the doctor's eyes: who holds which time, and which starts
 * are still free. Powers the staff booking form so the doctor picks a free
 * time instead of guessing into a booked one.
 */
export async function daySchedule(dateKey: string): Promise<{ closed: boolean; busy: DayBusy[]; free: DayFree[] }> {
  const { session } = await context();
  const now = new Date().toISOString();
  const timeZone = await clinicTimeZone(session.clinicId);
  const { db } = await context();
  const clinicSnap = await getDoc(doc(db, 'clinics', session.clinicId));
  const clinicData = (clinicSnap.data() ?? {}) as Record<string, unknown>;
  const rawHours = clinicData['workingHours'];
  const slotNum = (v: unknown, fallback: number): number =>
    typeof v === 'number' && Number.isFinite(v) && v >= 5 && v <= 480 ? Math.round(v) : fallback;
  const slotDuration = slotNum(clinicData['slotDurationMinutes'], 30);
  const weekday = weekdayOfDateKey(dateKey);
  const windows: { start: string; end: string }[] = [];
  if (Array.isArray(rawHours)) {
    const def = (rawHours as Record<string, unknown>[]).find(
      (d) => typeof d === 'object' && d !== null && d['weekday'] === weekday && d['enabled'] === true,
    );
    if (def) {
      const s1 = typeof def['start'] === 'string' ? def['start'] : '';
      const e1 = typeof def['end'] === 'string' ? def['end'] : '';
      if (/^\d{2}:\d{2}$/.test(s1) && /^\d{2}:\d{2}$/.test(e1) && e1 > s1) windows.push({ start: s1, end: e1 });
      const s2 = typeof def['start2'] === 'string' ? def['start2'] : '';
      const e2 = typeof def['end2'] === 'string' ? def['end2'] : '';
      if (/^\d{2}:\d{2}$/.test(s2) && /^\d{2}:\d{2}$/.test(e2) && e2 > s2) windows.push({ start: s2, end: e2 });
    }
  }
  const appts = await listAppointments(dateKey, dateKey);
  const direct = (await listDirectBookings().catch(() => [] as DirectBookingDoc[])).filter(
    (d) => d.status === 'confirmed' && d.startsAt.slice(0, 10) === dateKey,
  );
  const busy: DayBusy[] = [
    ...appts
      .filter((a) => a.status !== 'cancelled' && a.status !== 'no_show' && a.status !== 'rescheduled')
      .map((a) => ({
        startsAt: a.startsAt,
        endsAt: a.endsAt,
        patientName: a.patientName,
        kind: 'appointment' as const,
      })),
    ...direct.map((d) => ({
      startsAt: d.startsAt,
      endsAt: d.endsAt,
      patientName: d.patientName,
      kind: 'direct' as const,
    })),
  ].sort((a, b) => (a.startsAt < b.startsAt ? -1 : 1));
  if (windows.length === 0) return { closed: true, busy, free: [] };
  const all: DayFree[] = [];
  for (const w of windows) {
    const schedule = {
      id: 'live',
      clinicId: session.clinicId,
      workingHours: [{ weekday, enabled: true, start: w.start, end: w.end, breaks: [] }],
      slotDurationMinutes: slotDuration,
      slotIntervalMinutes: slotDuration,
      bufferMinutes: 0,
      maxDailyAppointments: null,
      holidays: [],
      blockedWindows: [],
      allowWalkIn: true,
      createdAt: now,
      updatedAt: now,
    };
    const generated = generateSlots({ schedule, timeZone, dateKey, durationMinutes: slotDuration, earliestUtc: now });
    for (const s of generated) all.push({ startsAt: s.startsAt, endsAt: s.endsAt, localStart: s.localStart });
  }
  all.sort((a, b) => (a.startsAt < b.startsAt ? -1 : 1));
  const free = all.filter((s) => {
    const start = new Date(s.startsAt).getTime();
    const end = new Date(s.endsAt).getTime();
    return !busy.some((b) => start < new Date(b.endsAt).getTime() && new Date(b.startsAt).getTime() < end);
  });
  return { closed: false, busy, free };
}

export async function setAppointmentStatus(id: string, status: 'scheduled' | 'checked_in' | 'completed' | 'cancelled'): Promise<void> {
  const { db, session } = await context();
  await updateDoc(doc(db, 'clinics', session.clinicId, 'appointments', id), {
    status,
    updatedAt: new Date().toISOString(),
  });
}

/** Firestore-mode postponement (API mode validates against live availability). */
export async function rescheduleAppointment(id: string, startsAt: string): Promise<void> {
  const { db, session } = await context();
  const start = new Date(startsAt).getTime();
  if (Number.isNaN(start)) throw new Error('Invalid start time.');
  await assertBookableTime(startsAt);
  const end = start + APPT_DURATION_MINUTES * 60_000;
  const dayKey = new Date(start).toISOString().slice(0, 10);
  const existing = await listAppointments(dayKey, dayKey);
  const clash = existing.some(
    (a) =>
      a.id !== id &&
      a.status !== 'cancelled' &&
      a.status !== 'no_show' &&
      start < new Date(a.endsAt).getTime() &&
      new Date(a.startsAt).getTime() < end,
  );
  if (clash) throw new Error('That time is not available.');
  await updateDoc(doc(db, 'clinics', session.clinicId, 'appointments', id), {
    startsAt: new Date(start).toISOString(),
    endsAt: new Date(end).toISOString(),
    updatedAt: new Date().toISOString(),
  });
}

export async function appointmentsForPatient(patientId: string): Promise<AppointmentDoc[]> {
  const { db, session } = await context();
  const snap = await getDocs(
    query(
      col(db, session.clinicId, 'appointments'),
      where('patientId', '==', patientId),
      orderBy('startsAt', 'desc'),
      limit(20),
    ),
  );
  return snap.docs.map((d) => toAppointment(d.id, d.data() as Record<string, unknown>));
}

// ---------------------------------------------------------------------------
// Visits / alerts / documents
// ---------------------------------------------------------------------------

export interface VisitDoc {
  id: string;
  visitType: string;
  chiefComplaint: string | null;
  diagnosis: string | null;
  plan: string | null;
  notes: string | null;
  createdAt: string;
}

export async function visitsForPatient(patientId: string, max = 20): Promise<VisitDoc[]> {
  const { db, session } = await context();
  const snap = await getDocs(
    query(
      col(db, session.clinicId, 'visits'),
      where('patientId', '==', patientId),
      orderBy('createdAt', 'desc'),
      limit(max),
    ),
  );
  return snap.docs.map((d) => {
    const data = d.data() as Record<string, unknown>;
    const text = (v: unknown): string | null => (typeof v === 'string' ? v : null);
    return {
      id: d.id,
      visitType: String(data['visitType'] ?? ''),
      chiefComplaint: text(data['chiefComplaint']),
      diagnosis: text(data['diagnosis']),
      plan: text(data['plan']),
      notes: text(data['notes']),
      createdAt: String(data['createdAt'] ?? ''),
    };
  });
}

export async function createVisit(input: {
  patientId: string;
  visitType: string;
  chiefComplaint?: string | null;
  diagnosis?: string | null;
  plan?: string | null;
  notes?: string | null;
}): Promise<string> {
  const { db, session } = await context();
  const now = new Date().toISOString();
  const ref = await addDoc(col(db, session.clinicId, 'visits'), {
    patientId: input.patientId,
    visitType: input.visitType,
    chiefComplaint: input.chiefComplaint ?? null,
    diagnosis: input.diagnosis ?? null,
    plan: input.plan ?? null,
    notes: input.notes ?? null,
    createdAt: now,
    updatedAt: now,
  });
  return ref.id;
}

export interface ClinicVisit {
  id: string;
  patientId: string;
  diagnosis: string | null;
}

/** Clinic-wide recent visits, for learning the doctor's habits. */
export async function listAllVisits(): Promise<ClinicVisit[]> {
  const { db, session } = await context();
  const snap = await getDocs(query(col(db, session.clinicId, 'visits'), orderBy('createdAt', 'desc'), limit(200)));
  return snap.docs.map((d) => {
    const data = d.data() as Record<string, unknown>;
    return {
      id: d.id,
      patientId: String(data['patientId'] ?? ''),
      diagnosis: typeof data['diagnosis'] === 'string' ? (data['diagnosis'] as string) : null,
    };
  });
}

/** Clinic-wide recent prescriptions, for learning the doctor's habits. */
export async function listAllPrescriptions(): Promise<{ visitId: string | null; items: PrescriptionItem[]; labs: Record<string, number>; createdAt: string }[]> {
  const { db, session } = await context();
  const snap = await getDocs(
    query(col(db, session.clinicId, 'prescriptions'), orderBy('createdAt', 'desc'), limit(200)),
  );
  return snap.docs.map((d) => {
    const full = toPrescriptionDoc(d.id, d.data() as Record<string, unknown>);
    const data = d.data() as Record<string, unknown>;
    return {
      visitId: typeof data['visitId'] === 'string' ? (data['visitId'] as string) : null,
      items: full.items,
      labs: full.labs,
      createdAt: full.createdAt,
    };
  });
}

export interface RequestedTestDoc {
  id: string;
  name: string;
  status: string;
  isShared: boolean;
  priority: 'routine' | 'urgent';
  prepNotes: string | null;
  documentId: string | null;
  notes: string | null;
  createdAt: string;
}

export async function orderTest(
  patientId: string,
  name: string,
  notes: string | null,
  extra?: { priority?: string | null; prepNotes?: string | null },
): Promise<void> {
  const { db, session } = await context();
  const now = new Date().toISOString();
  await addDoc(col(db, session.clinicId, 'requested_tests'), {
    patientId,
    visitId: null,
    name,
    status: 'requested',
    isShared: false,
    priority: extra?.priority === 'urgent' ? 'urgent' : 'routine',
    prepNotes: extra?.prepNotes?.trim() ? extra.prepNotes.trim() : null,
    documentId: null,
    notes,
    createdAt: now,
    updatedAt: now,
  });
}

export async function listRequestedTests(patientId: string, status?: string): Promise<RequestedTestDoc[]> {
  const { db, session } = await context();
  const filters = [where('patientId', '==', patientId)];
  if (status) filters.push(where('status', '==', status));
  const snap = await getDocs(
    query(col(db, session.clinicId, 'requested_tests'), ...filters, orderBy('createdAt', 'desc'), limit(100)),
  );
  return snap.docs.map((d) => {
    const data = d.data() as Record<string, unknown>;
    const text = (v: unknown): string | null => (typeof v === 'string' ? v : null);
    return {
      id: d.id,
      name: String(data['name'] ?? ''),
      status: String(data['status'] ?? 'requested'),
      isShared: data['isShared'] !== false,
      priority: data['priority'] === 'urgent' ? 'urgent' : 'routine',
      prepNotes: text(data['prepNotes']),
      documentId: text(data['documentId']),
      notes: text(data['notes']),
      createdAt: String(data['createdAt'] ?? ''),
    };
  });
}

export async function completeRequestedTest(id: string, documentId: string | null): Promise<void> {
  const { db, session } = await context();
  await updateDoc(doc(db, 'clinics', session.clinicId, 'requested_tests', id), {
    status: 'done',
    documentId,
    updatedAt: new Date().toISOString(),
  });
}

export interface PrescriptionItem {
  drug: string;
  dose?: string | null;
  frequency?: string | null;
  durationDays?: number | null;
  instructions?: string | null;
}

export interface PrescriptionDoc {
  id: string;
  items: PrescriptionItem[];
  diet: string[];
  exercise: string[];
  notes: string | null;
  status: string;
  isShared: boolean;
  labs: Record<string, number>;
  createdAt: string;
}

export async function createPrescription(input: {
  patientId: string;
  visitId?: string | null;
  items: PrescriptionItem[];
  diet: string[];
  exercise: string[];
  notes?: string | null;
}): Promise<void> {
  const { db, session } = await context();
  const now = new Date().toISOString();
  // Snapshot the chart labs with the order: this is what the dose-by-lab
  // learner reads back later.
  const vitals = await latestVitals(input.patientId, 100);
  const labs: Record<string, number> = {};
  for (const v of vitals) {
    if (!(v.kind in labs)) labs[v.kind] = v.value;
  }
  await addDoc(col(db, session.clinicId, 'prescriptions'), {
    patientId: input.patientId,
    visitId: input.visitId ?? null,
    items: input.items,
    diet: input.diet,
    exercise: input.exercise,
    labs,
    notes: input.notes ?? null,
    // Draft by default: invisible to the patient until the doctor approves
    // and shares (payment gate). Only approved actives ever sync.
    status: 'draft',
    isShared: false,
    createdAt: now,
    updatedAt: now,
  });
}

/** Approve one draft prescription (visible on next share). */
export async function approvePrescription(id: string): Promise<void> {
  const { db, session } = await context();
  await updateDoc(doc(db, 'clinics', session.clinicId, 'prescriptions', id), {
    status: 'active',
    updatedAt: new Date().toISOString(),
  });
}

/**
 * Payment/share gate: approve every draft prescription + unshared test, then
 * push the approved set to the patient app at once. This is the ONLY path
 * that writes the patient snapshot - nothing syncs automatically anymore.
 */
export async function approveAllAndShare(patientId: string): Promise<{ prescriptions: number; tests: number }> {
  const { db, session } = await context();
  const now = new Date().toISOString();
  const drafts = await getDocs(
    query(col(db, session.clinicId, 'prescriptions'), where('patientId', '==', patientId), where('status', '==', 'draft'), limit(50)),
  );
  for (const d of drafts.docs) {
    await updateDoc(doc(db, 'clinics', session.clinicId, 'prescriptions', d.id), {
      status: 'active',
      isShared: true,
      updatedAt: now,
    });
  }
  const tests = await getDocs(
    query(col(db, session.clinicId, 'requested_tests'), where('patientId', '==', patientId), limit(100)),
  );
  let sharedTests = 0;
  for (const t of tests.docs) {
    const data = t.data() as Record<string, unknown>;
    if (data['isShared'] === false || (data['isShared'] === undefined && data['status'] === 'requested')) {
      await updateDoc(doc(db, 'clinics', session.clinicId, 'requested_tests', t.id), {
        isShared: true,
        updatedAt: now,
      });
      sharedTests += 1;
    }
  }
  await shareSnapshotToPatientApp(patientId);
  return { prescriptions: drafts.size, tests: sharedTests };
}

function toPrescriptionDoc(id: string, data: Record<string, unknown>): PrescriptionDoc {
  const items = Array.isArray(data['items']) ? (data['items'] as PrescriptionItem[]) : [];
  const strings = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  const labsRaw = data['labs'] as Record<string, unknown> | undefined;
  const labs: Record<string, number> = {};
  if (labsRaw && typeof labsRaw === 'object') {
    for (const [key, value] of Object.entries(labsRaw)) {
      if (typeof value === 'number') labs[key] = value;
    }
  }
  return {
    id,
    items,
    diet: strings(data['diet']),
    exercise: strings(data['exercise']),
    notes: typeof data['notes'] === 'string' ? (data['notes'] as string) : null,
    status: String(data['status'] ?? 'active'),
    isShared: data['isShared'] !== false,
    labs,
    createdAt: String(data['createdAt'] ?? ''),
  };
}

export async function listPrescriptions(patientId: string, status?: string): Promise<PrescriptionDoc[]> {  const { db, session } = await context();
  const filters = [where('patientId', '==', patientId)];
  if (status) filters.push(where('status', '==', status));
  const snap = await getDocs(
    query(col(db, session.clinicId, 'prescriptions'), ...filters, orderBy('createdAt', 'desc'), limit(50)),
  );
  return snap.docs.map((d) => toPrescriptionDoc(d.id, d.data() as Record<string, unknown>));
}

export interface AlertDoc {
  id: string;
  severity: string;
  title: string;
  status: string;
}

const SEVERITY_RANK: Record<string, number> = { critical: 0, warning: 1, info: 2 };

export async function openAlerts(): Promise<AlertDoc[]> {
  const { db, session } = await context();
  const snap = await getDocs(
    query(col(db, session.clinicId, 'alerts'), where('status', '==', 'open'), orderBy('createdAt', 'desc'), limit(50)),
  );
  return snap.docs
    .map((d) => {
      const data = d.data() as Record<string, unknown>;
      return {
        id: d.id,
        severity: String(data['severity'] ?? 'info'),
        title: String(data['title'] ?? d.id),
        status: String(data['status'] ?? 'open'),
      };
    })
    .sort((a, b) => (SEVERITY_RANK[a.severity] ?? 3) - (SEVERITY_RANK[b.severity] ?? 3));
}

export async function alertsForPatient(patientId: string): Promise<AlertDoc[]> {
  const { db, session } = await context();
  const snap = await getDocs(
    query(
      col(db, session.clinicId, 'alerts'),
      where('patientId', '==', patientId),
      where('status', '==', 'open'),
      orderBy('createdAt', 'desc'),
      limit(20),
    ),
  );
  return snap.docs.map((d) => {
    const data = d.data() as Record<string, unknown>;
    return {
      id: d.id,
      severity: String(data['severity'] ?? 'info'),
      title: String(data['title'] ?? d.id),
      status: String(data['status'] ?? 'open'),
    };
  });
}

export interface DocumentDoc {
  id: string;
  patientId: string;
  kind: string;
  title: string | null;
  fileName: string;
  mimeType: string;
  status: string;
  downloadUrl: string | null;
  createdAt: string;
}

function toDocument(id: string, data: Record<string, unknown>): DocumentDoc {
  return {
    id,
    patientId: String(data['patientId'] ?? ''),
    kind: String(data['kind'] ?? ''),
    title: typeof data['title'] === 'string' ? (data['title'] as string) : null,
    fileName: String(data['fileName'] ?? id),
    mimeType: String(data['mimeType'] ?? ''),
    status: String(data['status'] ?? 'pending'),
    downloadUrl: typeof data['downloadUrl'] === 'string' ? (data['downloadUrl'] as string) : null,
    createdAt: String(data['createdAt'] ?? ''),
  };
}

export async function listDocuments(): Promise<DocumentDoc[]> {
  const { db, session } = await context();
  const snap = await getDocs(query(col(db, session.clinicId, 'documents'), orderBy('createdAt', 'desc'), limit(50)));
  return snap.docs.map((d) => toDocument(d.id, d.data() as Record<string, unknown>));
}

export async function documentsForPatient(patientId: string): Promise<DocumentDoc[]> {
  const { db, session } = await context();
  const snap = await getDocs(
    query(
      col(db, session.clinicId, 'documents'),
      where('patientId', '==', patientId),
      orderBy('createdAt', 'desc'),
      limit(50),
    ),
  );
  return snap.docs.map((d) => toDocument(d.id, d.data() as Record<string, unknown>));
}

export async function recordDocument(meta: {
  patientId: string;
  kind: string;
  title?: string | null;
  fileName: string;
  mimeType: string;
  byteSize: number;
  checksum: string;
  storagePath?: string | null;
  downloadUrl?: string | null;
}): Promise<string> {
  const { db, session } = await context();
  const now = new Date().toISOString();
  const ref = await addDoc(col(db, session.clinicId, 'documents'), {
    ...meta,
    title: meta.title ?? null,
    status: meta.storagePath || meta.downloadUrl ? 'stored' : 'pending',
    ocrText: null,
    createdAt: now,
    updatedAt: now,
  });
  return ref.id;
}

export async function attachOcr(id: string, text: string): Promise<void> {
  const { db, session } = await context();
  await updateDoc(doc(db, 'clinics', session.clinicId, 'documents', id), {
    ocrText: text,
    status: 'processed',
    updatedAt: new Date().toISOString(),
  });
}

export async function deleteDocument(id: string): Promise<void> {
  const { db, session } = await context();
  const ref = doc(db, 'clinics', session.clinicId, 'documents', id);
  const snap = await getDoc(ref);
  const storagePath = snap.data()?.['storagePath'];
  if (typeof storagePath === 'string' && storagePath) {
    // Best effort: the record is what matters, a stranded object is not.
    try {
      const fb = await import('./firebase.js');
      const bucket = fb.storageBucket();
      if (bucket) {
        const { getStorage, ref: storageRef, deleteObject } = await import('firebase/storage');
        await deleteObject(storageRef(getStorage(fb.getFirebaseApp(), `gs://${bucket}`), storagePath));
      }
    } catch {
      // Fall through to deleting the record regardless.
    }
  }
  const { deleteDoc } = await import('firebase/firestore');
  await deleteDoc(ref);
}

/**
 * Firebase Storage for real file bytes (lazy SDK: only downloaded on builds
 * that actually upload). The Firestore doc keeps the metadata + download URL;
 * Storage holds the bytes. Without a configured bucket this throws a clear
 * error instead of pretending the upload worked.
 */
export async function uploadDocumentBytes(docId: string, fileName: string, blob: Blob): Promise<string> {
  const { db, session } = await context();
  const fb = await import('./firebase.js');
  const bucket = fb.storageBucket();
  if (!bucket) throw new Error('File storage is not enabled for this clinic project.');
  const { getStorage, ref, uploadBytes, getDownloadURL } = await import('firebase/storage');
  const storage = getStorage(fb.getFirebaseApp(), `gs://${bucket}`);
  const path = `clinics/${session.clinicId}/documents/${docId}/${fileName}`;
  await uploadBytes(ref(storage, path), blob);
  const url = await getDownloadURL(ref(storage, path));
  await updateDoc(doc(db, 'clinics', session.clinicId, 'documents', docId), {
    storagePath: path,
    downloadUrl: url,
    status: 'stored',
    updatedAt: new Date().toISOString(),
  });
  return url;
}

// ---------------------------------------------------------------------------
// Finance (integer minor units, always)
// ---------------------------------------------------------------------------

export interface InvoiceDoc {
  id: string;
  patientId: string;
  status: string;
  totalMinor: number;
  paidMinor: number;
  insurerId: string | null;
  insurerShareMinor: number;
  patientShareMinor: number;
  currency: string;
  createdAt: string;
}

function toInvoice(id: string, data: Record<string, unknown>): InvoiceDoc {
  const total = Number(data['totalMinor'] ?? 0);
  const paid = Number(data['paidMinor'] ?? 0);
  return {
    id,
    patientId: String(data['patientId'] ?? ''),
    status: String(data['status'] ?? ''),
    totalMinor: total,
    paidMinor: paid,
    insurerId: typeof data['insurerId'] === 'string' ? (data['insurerId'] as string) : null,
    insurerShareMinor: Number(data['insurerShareMinor'] ?? 0),
    patientShareMinor: Number(data['patientShareMinor'] ?? total),
    currency: String(data['currency'] ?? ''),
    createdAt: String(data['createdAt'] ?? ''),
  };
}

export async function listInvoices(): Promise<InvoiceDoc[]> {
  const { db, session } = await context();
  const snap = await getDocs(query(col(db, session.clinicId, 'invoices'), orderBy('createdAt', 'desc'), limit(50)));
  return snap.docs.map((d) => toInvoice(d.id, d.data() as Record<string, unknown>));
}

export async function invoicesForPatient(patientId: string): Promise<InvoiceDoc[]> {
  const { db, session } = await context();
  const snap = await getDocs(
    query(
      col(db, session.clinicId, 'invoices'),
      where('patientId', '==', patientId),
      orderBy('createdAt', 'desc'),
      limit(50),
    ),
  );
  return snap.docs.map((d) => toInvoice(d.id, d.data() as Record<string, unknown>));
}

export async function createInvoice(patientId: string, unitPriceMinor: number): Promise<void> {
  const { db, session } = await context();
  if (!Number.isInteger(unitPriceMinor) || unitPriceMinor <= 0) {
    throw new Error('Amount must be a positive whole number of minor units.');
  }
  const now = new Date().toISOString();
  // Same split as the API: the patient's active insurer covers its percent.
  let insurerId: string | null = null;
  let insurerShare = 0;
  const patient = await getPatient(patientId);
  if (patient?.insurerId) {
    const insurerSnap = await getDoc(doc(db, 'clinics', session.clinicId, 'insurers', patient.insurerId));
    const insurer = insurerSnap.data() as Record<string, unknown> | undefined;
    if (insurer && insurer['isActive'] !== false) {
      const pct = Number(insurer['coveragePercent'] ?? 0);
      if (pct > 0) {
        insurerId = patient.insurerId;
        insurerShare = Math.min(Math.round((unitPriceMinor * pct) / 100), unitPriceMinor);
      }
    }
  }
  await addDoc(col(db, session.clinicId, 'invoices'), {
    patientId,
    items: [{ description: 'consultation', unitPriceMinor, quantity: 1 }],
    totalMinor: unitPriceMinor,
    paidMinor: 0,
    insurerId,
    insurerShareMinor: insurerShare,
    patientShareMinor: unitPriceMinor - insurerShare,
    status: 'unpaid',
    currency: await clinicCurrency(session.clinicId),
    createdAt: now,
    updatedAt: now,
  });
}

export async function recordPayment(patientId: string, invoiceId: string | null, amountMinor: number, method: string): Promise<void> {
  const { db, session } = await context();
  if (!Number.isInteger(amountMinor) || amountMinor <= 0) {
    throw new Error('Amount must be a positive whole number of minor units.');
  }
  const now = new Date().toISOString();
  await addDoc(col(db, session.clinicId, 'payments'), {
    patientId,
    ...(invoiceId ? { invoiceId } : {}),
    amountMinor,
    method,
    status: 'paid',
    direction: 'payment',
    performedAt: now,
    createdAt: now,
  });
  if (invoiceId) {
    const ref = doc(db, 'clinics', session.clinicId, 'invoices', invoiceId);
    const snap = await getDoc(ref);
    const data = snap.data() as Record<string, unknown> | undefined;
    if (data) {
      const total = Number(data['totalMinor'] ?? 0);
      const owed = Number(data['patientShareMinor'] ?? total);
      const paid = Number(data['paidMinor'] ?? 0) + amountMinor;
      await updateDoc(ref, {
        paidMinor: paid,
        status: paid <= 0 ? 'unpaid' : paid >= owed ? 'paid' : 'partial',
        updatedAt: now,
      });
    }
  }
}

export interface PaymentDoc {
  id: string;
  invoiceId: string | null;
  amountMinor: number;
  method: string;
  createdAt: string;
}

export async function listPayments(patientId?: string, invoiceId?: string): Promise<PaymentDoc[]> {
  const { db, session } = await context();
  const filters = [];
  if (patientId) filters.push(where('patientId', '==', patientId));
  if (invoiceId) filters.push(where('invoiceId', '==', invoiceId));
  const snap = await getDocs(
    query(col(db, session.clinicId, 'payments'), ...filters, orderBy('createdAt', 'desc'), limit(100)),
  );
  return snap.docs.map((d) => {
    const data = d.data() as Record<string, unknown>;
    return {
      id: d.id,
      invoiceId: typeof data['invoiceId'] === 'string' ? (data['invoiceId'] as string) : null,
      amountMinor: Number(data['amountMinor'] ?? 0),
      method: String(data['method'] ?? ''),
      createdAt: String(data['createdAt'] ?? ''),
    };
  });
}

export interface InsurerDoc {
  id: string;
  name: string;
  nameAr: string | null;
  coveragePercent: number;
  annualLimitMinor: number | null;
  perVisitLimitMinor: number | null;
  phone: string | null;
  email: string | null;
  notes: string | null;
  isActive: boolean;
  createdAt: string;
}

function toInsurer(id: string, data: Record<string, unknown>): InsurerDoc {
  const numOrNull = (v: unknown): number | null => (typeof v === 'number' ? v : null);
  const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);
  return {
    id,
    name: String(data['name'] ?? ''),
    nameAr: strOrNull(data['nameAr']),
    coveragePercent: Number(data['coveragePercent'] ?? 0),
    annualLimitMinor: numOrNull(data['annualLimitMinor']),
    perVisitLimitMinor: numOrNull(data['perVisitLimitMinor']),
    phone: strOrNull(data['phone']),
    email: strOrNull(data['email']),
    notes: strOrNull(data['notes']),
    isActive: data['isActive'] !== false,
    createdAt: String(data['createdAt'] ?? ''),
  };
}

export async function listInsurers(): Promise<InsurerDoc[]> {
  const { db, session } = await context();
  const snap = await getDocs(query(col(db, session.clinicId, 'insurers'), orderBy('name', 'asc'), limit(100)));
  return snap.docs.map((d) => toInsurer(d.id, d.data() as Record<string, unknown>));
}

export async function createInsurer(input: {
  name: string;
  nameAr?: string | null;
  coveragePercent: number;
  annualLimitMinor?: number | null;
  perVisitLimitMinor?: number | null;
  phone?: string | null;
  email?: string | null;
  notes?: string | null;
}): Promise<void> {
  const { db, session } = await context();
  if (!input.name.trim()) throw new Error('Insurer name is required.');
  if (!(input.coveragePercent >= 0 && input.coveragePercent <= 100)) {
    throw new Error('Coverage percent must be between 0 and 100.');
  }
  const now = new Date().toISOString();
  await addDoc(col(db, session.clinicId, 'insurers'), {
    name: input.name.trim(),
    nameAr: input.nameAr ?? null,
    coveragePercent: input.coveragePercent,
    annualLimitMinor: input.annualLimitMinor ?? null,
    perVisitLimitMinor: input.perVisitLimitMinor ?? null,
    phone: input.phone ?? null,
    email: input.email ?? null,
    notes: input.notes ?? null,
    isActive: true,
    createdAt: now,
    updatedAt: now,
  });
}

export async function updateInsurer(id: string, input: Partial<InsurerDoc>): Promise<void> {
  const { db, session } = await context();
  const values: Record<string, unknown> = { updatedAt: new Date().toISOString() };
  if (input.name !== undefined) values['name'] = input.name;
  if (input.nameAr !== undefined) values['nameAr'] = input.nameAr;
  if (input.coveragePercent !== undefined) {
    if (!(input.coveragePercent >= 0 && input.coveragePercent <= 100)) {
      throw new Error('Coverage percent must be between 0 and 100.');
    }
    values['coveragePercent'] = input.coveragePercent;
  }
  if (input.annualLimitMinor !== undefined) values['annualLimitMinor'] = input.annualLimitMinor;
  if (input.perVisitLimitMinor !== undefined) values['perVisitLimitMinor'] = input.perVisitLimitMinor;
  if (input.phone !== undefined) values['phone'] = input.phone;
  if (input.email !== undefined) values['email'] = input.email;
  if (input.notes !== undefined) values['notes'] = input.notes;
  if (input.isActive !== undefined) values['isActive'] = input.isActive;
  await updateDoc(doc(db, 'clinics', session.clinicId, 'insurers', id), values);
}

export interface InsurerStatement {
  insurer: InsurerDoc;
  billedMinor: number;
  collectedMinor: number;
  outstandingMinor: number;
  invoices: { id: string; patientId: string; patientName: string; policyNo: string | null; totalMinor: number; insurerShareMinor: number; status: string; createdAt: string }[];
  receipts: { id: string; amountMinor: number; reference: string | null; note: string | null; receivedAt: string }[];
}

export async function insurerStatement(id: string): Promise<InsurerStatement> {
  const { db, session } = await context();
  const insurerSnap = await getDoc(doc(db, 'clinics', session.clinicId, 'insurers', id));
  if (!insurerSnap.exists()) throw new Error('Insurer not found.');
  const insurer = toInsurer(id, insurerSnap.data() as Record<string, unknown>);

  const invoicesSnap = await getDocs(
    query(
      col(db, session.clinicId, 'invoices'),
      where('insurerId', '==', id),
      orderBy('createdAt', 'desc'),
      limit(100),
    ),
  );
  let billedMinor = 0;
  const invoices: InsurerStatement['invoices'] = [];
  for (const d of invoicesSnap.docs) {
    const data = d.data() as Record<string, unknown>;
    const share = Number(data['insurerShareMinor'] ?? 0);
    billedMinor += share;
    const patientId = String(data['patientId'] ?? '');
    const patient = await getPatient(patientId);
    invoices.push({
      id: d.id,
      patientId,
      patientName: patient?.fullName ?? patientId,
      policyNo: patient?.insurerPolicyNo ?? null,
      totalMinor: Number(data['totalMinor'] ?? 0),
      insurerShareMinor: share,
      status: String(data['status'] ?? ''),
      createdAt: String(data['createdAt'] ?? ''),
    });
  }

  const receiptsSnap = await getDocs(
    query(
      col(db, session.clinicId, 'insurer_payments'),
      where('insurerId', '==', id),
      orderBy('receivedAt', 'desc'),
      limit(100),
    ),
  );
  let collectedMinor = 0;
  const receipts = receiptsSnap.docs.map((d) => {
    const data = d.data() as Record<string, unknown>;
    collectedMinor += Number(data['amountMinor'] ?? 0);
    return {
      id: d.id,
      amountMinor: Number(data['amountMinor'] ?? 0),
      reference: typeof data['reference'] === 'string' ? (data['reference'] as string) : null,
      note: typeof data['note'] === 'string' ? (data['note'] as string) : null,
      receivedAt: String(data['receivedAt'] ?? ''),
    };
  });

  return { insurer, billedMinor, collectedMinor, outstandingMinor: billedMinor - collectedMinor, invoices, receipts };
}

export async function recordInsurerPayment(insurerId: string, amountMinor: number, reference: string | null): Promise<void> {
  const { db, session } = await context();
  if (!Number.isInteger(amountMinor) || amountMinor <= 0) {
    throw new Error('Amount must be a positive whole number of minor units.');
  }
  const statement = await insurerStatement(insurerId);
  if (amountMinor > statement.outstandingMinor) {
    throw new Error('Collection cannot exceed what the insurer owes.');
  }
  const now = new Date().toISOString();
  await addDoc(col(db, session.clinicId, 'insurer_payments'), {
    insurerId,
    amountMinor,
    reference,
    note: null,
    receivedAt: now,
    createdAt: now,
  });
}

export async function financeSummary(): Promise<{ outstandingMinor: number; collectedMinor: number; currency: string }> {
  const invoices = await listInvoices();
  const { db, session } = await context();
  const payments = await getDocs(query(col(db, session.clinicId, 'payments'), orderBy('createdAt', 'desc'), limit(200)));
  let collectedMinor = 0;
  for (const d of payments.docs) {
    collectedMinor += Number((d.data() as Record<string, unknown>)['amountMinor'] ?? 0);
  }
  const outstandingMinor = invoices
    .filter((i) => i.status !== 'paid')
    .reduce((sum, i) => sum + Math.max(0, i.patientShareMinor - i.paidMinor), 0);
  return {
    outstandingMinor,
    collectedMinor,
    currency: invoices[0]?.currency ?? (await clinicCurrency(session.clinicId)),
  };
}

// ---------------------------------------------------------------------------
// Messaging (the app enqueues; the Baileys gateway drains `queued` rows)
// ---------------------------------------------------------------------------

export interface ThreadDoc {
  id: string;
  patientId: string | null;
  lastMessageAt: string | null;
  unreadCount: number;
}

export interface MessageDoc {
  id: string;
  direction: string;
  body: string;
  status: string;
  createdAt: string;
}

export interface OutboxDoc {
  id: string;
  to: string;
  body: string;
  template: string;
  status: string;
  manualSentAt: string | null;
}

export async function listThreads(): Promise<ThreadDoc[]> {
  const { db, session } = await context();
  const snap = await getDocs(query(col(db, session.clinicId, 'threads'), orderBy('lastMessageAt', 'desc'), limit(50)));
  return snap.docs.map((d) => {
    const data = d.data() as Record<string, unknown>;
    return {
      id: d.id,
      patientId: typeof data['patientId'] === 'string' ? (data['patientId'] as string) : null,
      lastMessageAt: typeof data['lastMessageAt'] === 'string' ? (data['lastMessageAt'] as string) : null,
      unreadCount: Number(data['unreadCount'] ?? 0),
    };
  });
}

export async function threadMessages(threadId: string): Promise<MessageDoc[]> {
  const { db, session } = await context();
  const snap = await getDocs(
    query(
      collection(db, 'clinics', session.clinicId, 'threads', threadId, 'messages'),
      orderBy('createdAt', 'asc'),
      limit(200),
    ),
  );
  return snap.docs.map((d) => {
    const data = d.data() as Record<string, unknown>;
    return {
      id: d.id,
      direction: String(data['direction'] ?? ''),
      body: String(data['body'] ?? ''),
      status: String(data['status'] ?? ''),
      createdAt: String(data['createdAt'] ?? ''),
    };
  });
}

export async function markThreadRead(threadId: string): Promise<void> {
  const { db, session } = await context();
  await updateDoc(doc(db, 'clinics', session.clinicId, 'threads', threadId), { unreadCount: 0 });
}

export async function sendPatientMessage(patientId: string, body: string): Promise<void> {
  const { db, session } = await context();
  const patient = await getPatient(patientId);
  if (!patient) throw new Error('Patient not found.');
  if (!patient.whatsappOptIn) throw new Error('This patient has opted out of WhatsApp messages.');
  const now = new Date().toISOString();

  const threads = await getDocs(
    query(col(db, session.clinicId, 'threads'), where('patientId', '==', patientId), limit(1)),
  );
  let threadId: string;
  const existing = threads.docs[0];
  if (existing) {
    threadId = existing.id;
  } else {
    const ref = await addDoc(col(db, session.clinicId, 'threads'), {
      patientId,
      channel: 'whatsapp',
      unreadCount: 0,
      lastMessageAt: now,
      createdAt: now,
    });
    threadId = ref.id;
  }

  await addDoc(collection(db, 'clinics', session.clinicId, 'threads', threadId, 'messages'), {
    direction: 'outbound',
    body,
    status: 'queued',
    createdAt: now,
  });
  await updateDoc(doc(db, 'clinics', session.clinicId, 'threads', threadId), { lastMessageAt: now });

  // The gateway picks up `queued` rows and delivers them. The app never talks
  // to WhatsApp directly, so a provider outage cannot lose a message.
  await addDoc(col(db, session.clinicId, 'outbox'), {
    to: patient.whatsappNumber ?? patient.phone,
    body,
    template: 'custom',
    patientId,
    threadId,
    status: 'queued',
    attempts: 0,
    scheduledFor: now,
    createdAt: now,
    updatedAt: now,
  });
}

export async function listOutbox(): Promise<OutboxDoc[]> {
  const { db, session } = await context();
  const snap = await getDocs(query(col(db, session.clinicId, 'outbox'), orderBy('createdAt', 'desc'), limit(50)));
  return snap.docs.map((d) => {
    const data = d.data() as Record<string, unknown>;
    return {
      id: d.id,
      to: String(data['to'] ?? ''),
      body: String(data['body'] ?? ''),
      template: String(data['template'] ?? ''),
      status: String(data['status'] ?? ''),
      manualSentAt: typeof data['manualSentAt'] === 'string' ? (data['manualSentAt'] as string) : null,
    };
  });
}

/**
 * Manual click-to-send (Firestore mode): the doctor sends from the WhatsApp
 * app; the client records the human press without touching `status` (rules
 * forbid clients from changing it). Rows carrying `manualSentAt` are hidden
 * from the pending queue, and the gateway sweep marks them `sent`.
 */
export async function manualSendOutbox(id: string): Promise<void> {
  const { db, session } = await context();
  const now = new Date().toISOString();
  await updateDoc(doc(db, 'clinics', session.clinicId, 'outbox', id), {
    manualSentAt: now,
    updatedAt: now,
  });
}

// ---------------------------------------------------------------------------
// Patient-app linking + sharing (staff side).
//
// The patient reads a 6-letter ticket out; staff type it here. The ticket
// resolves to the patient's capability account id, the secret is verified,
// both sides are linked, and the single-use ticket is deleted. Tickets older
// than 10 minutes are rejected.
// ---------------------------------------------------------------------------

export interface PatientLinkResult {
  accountId: string;
  fullName: string;
  phone: string;
}

/**
 * Import a registered patient-app account into this clinic by phone number.
 * The phone directory resolves to the capability account id; the account's
 * own phone field must match the searched number, so a forged directory
 * entry pointing elsewhere is rejected. The local file is prefilled from the
 * patient's self-reported health profile, and both sides are linked.
 *
 * Numbers match loosely: `70xxxxxx`, `+96170xxxxxx` and `96170xxxxxx` all
 * find the same account, so staff typing and patient registration formats
 * never have to agree character-for-character.
 */
export async function importPatientAccountByPhone(phone: string): Promise<{ localId: string; account: PatientLinkResult }> {
  const { db, session } = await context();
  const rawDigits = phone.replace(/\D/g, '');
  if (rawDigits.length < 7) throw new Error('Enter a valid phone number.');
  const candidates: string[] = [];
  const push = (d: string): void => {
    if (d.length >= 7 && !candidates.includes(d)) candidates.push(d);
  };
  push(rawDigits);
  if (rawDigits.startsWith('961')) push(rawDigits.slice(3));
  else push(`961${rawDigits}`);
  if (rawDigits.startsWith('0')) push(rawDigits.slice(1));
  let accountId: string | null = null;
  for (const digits of candidates) {
    const dirSnap = await getDoc(doc(db, 'patientPhones', digits));
    if (!dirSnap.exists()) continue;
    const found = (dirSnap.data() as Record<string, unknown>)['accountId'];
    if (typeof found === 'string' && found) {
      accountId = found;
      break;
    }
  }
  if (!accountId) throw new Error('not-registered');
  const accountSnap = await getDoc(doc(db, 'patientAccounts', accountId));
  if (!accountSnap.exists()) throw new Error('not-registered');
  const account = accountSnap.data() as Record<string, unknown>;
  const accountDigits = typeof account['phone'] === 'string' ? (account['phone'] as string).replace(/\D/g, '') : '';
  const accountVariants = new Set<string>();
  accountVariants.add(accountDigits);
  if (accountDigits.startsWith('961')) accountVariants.add(accountDigits.slice(3));
  else accountVariants.add(`961${accountDigits}`);
  if (accountDigits.startsWith('0')) accountVariants.add(accountDigits.slice(1));
  if (!candidates.some((c) => accountVariants.has(c))) {
    throw new Error('not-registered');
  }

  // Already have them? Return the existing file instead of duplicating.
  const existing = await findPatientByPhoneExact(String(account['phone'] ?? ''));
  const now = new Date().toISOString();
  const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
  const nulStr = (v: unknown): string | null => (typeof v === 'string' ? v : null);
  const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);
  const arr = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  const fullName = str(account['fullName'], rawDigits);
  let localId: string;
  if (existing) {
    localId = existing.id;
    // Already filed locally: still link both sides so the doctor sees the
    // patient's app uploads + vitals and snapshots reach the patient.
    const nowLink = new Date().toISOString();
    await updateDoc(doc(db, 'clinics', session.clinicId, 'patients', existing.id), {
      patientAppId: accountId,
      updatedAt: nowLink,
    });
    await updateDoc(doc(db, 'patientAccounts', accountId), {
      [`links.${session.clinicId}`]: { patientId: existing.id, linkedAt: nowLink },
      updatedAt: nowLink,
    }).catch(() => undefined);
  } else {    const parts = fullName.trim().split(/\s+/);
    const mrn = await runTransaction(db, async (tx) => {
      const counterRef = doc(db, 'clinics', session.clinicId, 'counters', 'mrn');
      const counter = await tx.get(counterRef);
      const seq = ((counter.data()?.['seq'] as number | undefined) ?? 0) + 1;
      tx.set(counterRef, { seq }, { merge: true });
      return formatMrn('MRN', seq);
    });
    const created = await addDoc(col(db, session.clinicId, 'patients'), {
      fullName,
      firstName: str(account['firstName'], parts[0] ?? fullName),
      lastName: str(account['lastName'], parts.slice(1).join(' ') || '—'),
      phone: str(account['phone']),
      whatsappNumber: str(account['phone']),
      mrn,
      sex: 'unknown',
      preferredLanguage: 'en',
      whatsappOptIn: true,
      whatsappOptInAt: now,
      dateOfBirth: nulStr(account['dateOfBirth']),
      ageYears: null,
      heightCm: num(account['heightCm']),
      weightKg: num(account['weightKg']),
      address: nulStr(account['address']),
      city: null,
      bloodGroup: nulStr(account['bloodGroup']),
      insurerId: null,
      insurerPolicyNo: null,
      chronicConditions: arr(account['chronicConditions']),
      allergies: arr(account['allergies']),
      currentMedications: arr(account['currentMedications']),
      patientAppId: accountId,
      search: `${fullName} ${str(account['phone'])} ${mrn}`.toLowerCase(),
      createdAt: now,
      updatedAt: now,
    });
    localId = created.id;
  }
  await updateDoc(doc(db, 'clinics', session.clinicId, 'patients', localId), {
    patientAppId: accountId,
    updatedAt: now,
  });
  await updateDoc(doc(db, 'patientAccounts', accountId), {
    [`links.${session.clinicId}`]: { patientId: localId, linkedAt: now },
    updatedAt: now,
  });
  return { localId, account: { accountId, fullName, phone: str(account['phone']) } };
}

/**
 * Share a snapshot of the chart into the patient's own account subtree.
 * The patient reads it from their app; the clinic keeps the source of truth.
 * Only linked patients (patientAppId set) can receive a snapshot.
 */
export async function shareSnapshotToPatientApp(patientId: string): Promise<string> {
  const { db, session } = await context();
  const patient = await getPatient(patientId);
  if (!patient) throw new Error('Patient not found.');
  if (!patient.patientAppId) throw new Error('Link the patient app first.');
  const payload = await buildSnapshotPayload(patientId);
  const now = new Date().toISOString();
  await setDoc(doc(db, 'patientAccounts', patient.patientAppId, 'records', session.clinicId), {
    ...payload,
    updatedAt: now,
  });
  return payload.clinicName;
}

async function buildSnapshotPayload(patientId: string): Promise<{
  clinicId: string;
  clinicName: string;
  medications: { drug: string; dose: string | null; frequency: string | null }[];
  vitals: { kind: string; value: number; unit: string; measuredAt: string }[];
  visits: { visitType: string; diagnosis: string | null; createdAt: string }[];
  appointments: { startsAt: string; status: string }[];
  requestedTests: { name: string; priority: string; prepNotes: string | null; createdAt: string }[];
  lifestyle: { targets: string[]; diet: string[]; exercise: string[] };
}> {
  const { session } = await context();
  const patient = await getPatient(patientId);
  if (!patient) throw new Error('Patient not found.');
  const [vitals, visits, appointments, prescriptions, tests] = await Promise.all([
    latestVitals(patientId, 30),
    visitsForPatient(patientId, 10),
    appointmentsForPatient(patientId),
    listPrescriptions(patientId, 'active'),
    listRequestedTests(patientId),
  ]);
  const clinicName = await clinicDisplayName(session.clinicId);
  const labOf = (kind: string): number | null => vitals.find((v) => v.kind === kind)?.value ?? null;
  return {
    clinicId: session.clinicId,
    clinicName,
    medications: prescriptions.flatMap((rx) =>
      rx.items.map((i) => ({ drug: i.drug, dose: i.dose ?? null, frequency: i.frequency ?? null })),
    ),
    vitals: vitals.slice(0, 20).map((v) => ({ kind: v.kind, value: v.value, unit: v.unit, measuredAt: v.measuredAt })),
    visits: visits.slice(0, 10).map((v) => ({ visitType: v.visitType, diagnosis: v.diagnosis, createdAt: v.createdAt })),
    appointments: appointments
      .slice(0, 10)
      .map((a) => ({ startsAt: a.startsAt, status: a.status })),
    requestedTests: tests
      .filter((x) => x.status === 'requested' && x.isShared !== false)
      .map((x) => ({ name: x.name, priority: x.priority, prepNotes: x.prepNotes, createdAt: x.createdAt })),
    lifestyle: recommendLifestyle({
      diagnosis: visits[0]?.diagnosis ?? '',
      conditions: patient.chronicConditions,
      labs: {
        hba1c: labOf('hba1c'),
        systolic: labOf('systolic_bp'),
        ldl: labOf('ldl'),
        triglycerides: labOf('triglycerides'),
        microalbumin: labOf('microalbumin'),
        urineAcr: labOf('urine_acr'),
        creatinine: labOf('creatinine'),
        urea: labOf('urea') ?? labOf('blood_urea'),
        egfr: null,
      },
      weightKg: patient.weightKg,
      ageYears: patient.ageYears,
    }),
  };
}

export interface PatientAppUpload {
  id: string;
  fileName: string;
  dataUrl: string;
  createdAt: string;
}

export interface PatientAppVital {
  kind: string;
  value: number;
  unit: string;
  measuredAt: string;
}

/** Staff read of a linked patient's own uploads + confirmed readings. */
export async function patientAppUploads(appId: string): Promise<PatientAppUpload[]> {
  const { db } = await context();
  const snap = await getDocs(
    query(collection(db, 'patientAccounts', appId, 'uploads'), orderBy('createdAt', 'desc'), limit(20)),
  );
  return snap.docs.map((d) => {
    const data = d.data() as Record<string, unknown>;
    return {
      id: d.id,
      fileName: typeof data['fileName'] === 'string' ? (data['fileName'] as string) : d.id,
      dataUrl: typeof data['dataUrl'] === 'string' ? (data['dataUrl'] as string) : '',
      createdAt: typeof data['createdAt'] === 'string' ? (data['createdAt'] as string) : '',
    };
  });
}

export async function patientAppVitals(appId: string): Promise<PatientAppVital[]> {
  const { db } = await context();
  const snap = await getDocs(
    query(collection(db, 'patientAccounts', appId, 'myVitals'), orderBy('measuredAt', 'desc'), limit(30)),
  );
  return snap.docs.map((d) => {
    const data = d.data() as Record<string, unknown>;
    return {
      kind: String(data['kind'] ?? ''),
      value: Number(data['value'] ?? 0),
      unit: String(data['unit'] ?? ''),
      measuredAt: typeof data['measuredAt'] === 'string' ? (data['measuredAt'] as string) : '',
    };
  });
}

export interface DoctorInvite {
  code: string;
  usedBy: string | null;
  createdAt: string;
}

const INVITE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function randomInviteCode(length = 8): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => INVITE_ALPHABET[b % INVITE_ALPHABET.length]).join('');
}

/**
 * Owner creates a doctor invite (written twice: top-level for the joining
 * doctor to redeem, mirrored under the clinic for the owner to list/revoke).
 */
export async function createDoctorInvite(): Promise<string> {
  const { db, session } = await context();
  const code = randomInviteCode();
  const now = new Date().toISOString();
  const payload = { code, type: 'doctor', clinicId: session.clinicId, note: null, createdAt: now };
  await setDoc(doc(db, 'invites', code), payload);
  await setDoc(doc(db, 'clinics', session.clinicId, 'invites', code), payload);
  return code;
}

export async function listMyInvites(): Promise<DoctorInvite[]> {
  const { db, session } = await context();
  const snap = await getDocs(
    query(collection(db, 'clinics', session.clinicId, 'invites'), orderBy('createdAt', 'desc'), limit(50)),
  );
  return snap.docs.map((d) => {
    const data = d.data() as Record<string, unknown>;
    return {
      code: d.id,
      usedBy: typeof data['usedBy'] === 'string' ? (data['usedBy'] as string) : null,
      createdAt: typeof data['createdAt'] === 'string' ? (data['createdAt'] as string) : '',
    };
  });
}

export async function revokeDoctorInvite(code: string): Promise<void> {
  const { db, session } = await context();
  const { deleteDoc } = await import('firebase/firestore');
  await deleteDoc(doc(db, 'clinics', session.clinicId, 'invites', code)).catch(() => undefined);
  await deleteDoc(doc(db, 'invites', code)).catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Follow-ups
// ---------------------------------------------------------------------------

export async function followUpCounts(): Promise<{ due: number; active: number }> {
  const { db, session } = await context();
  const snap = await getDocs(query(col(db, session.clinicId, 'followups'), where('status', '==', 'active'), limit(200)));
  const now = new Date().toISOString();
  let due = 0;
  for (const d of snap.docs) {
    const nextDue = (d.data() as Record<string, unknown>)['nextDueAt'];
    if (typeof nextDue === 'string' && nextDue <= now) due += 1;
  }
  return { due, active: snap.size };
}

// ---------------------------------------------------------------------------
// Decision support (runs on-device with the shared clinical library)
// ---------------------------------------------------------------------------

export interface LabBasis {
  kind: string;
  value: number;
  unit: string;
  measuredAt: string;
}

export interface LabGuidedDose {
  drug: string;
  dose: string;
  frequency: string;
  reasons: string[];
  contraindicated: boolean;
}

export interface ReviewResult {
  severity: string;
  warnings: string[];
  suggestions: string[];
  regimen: PrescriptionItem[];
  labs: LabBasis[];
  labGuided: LabGuidedDose[];
  lifestyle: { targets: string[]; diet: string[]; exercise: string[] };
  raw: unknown;
}

export async function runReview(patientId: string, diagnosis: string, medications: string[]): Promise<ReviewResult> {
  const patient = await getPatient(patientId);
  if (!patient) throw new Error('Patient not found.');
  const vitals = await latestVitals(patientId, 100);

  // The engine must see the same chart the doctor sees: clinic readings PLUS
  // the patient's own OCR-confirmed app readings (same kinds, freshest wins).
  // Otherwise populated vitals mysteriously "miss" the review.
  type MergedVital = { kind: string; value: number; unit: string; measuredAt: string };
  const normKind = (k: string): string => {
    const t = k.toLowerCase().trim();
    return t === 'blood_urea' ? 'urea' : t;
  };
  const merged: MergedVital[] = vitals.map((v) => ({
    kind: normKind(v.kind),
    value: v.value,
    unit: v.unit,
    measuredAt: v.measuredAt,
  }));
  if (patient.patientAppId) {
    try {
      const { getFirestoreInstance } = await import('./firebase.js');
      const fdb = getFirestoreInstance();
      const appSnap = await getDocs(
        query(
          collection(fdb, 'patientAccounts', patient.patientAppId, 'myVitals'),
          orderBy('measuredAt', 'desc'),
          limit(100),
        ),
      );
      for (const d of appSnap.docs) {
        const data = d.data() as Record<string, unknown>;
        const kind = String(data['kind'] ?? '');
        if (!kind) continue;
        merged.push({
          kind: normKind(kind),
          value: Number(data['value'] ?? 0),
          unit: String(data['unit'] ?? ''),
          measuredAt: typeof data['measuredAt'] === 'string' ? (data['measuredAt'] as string) : '',
        });
      }
    } catch {
      // App readings are a bonus: clinic data alone still reviews.
    }
  }
  merged.sort((a, b) => (a.measuredAt < b.measuredAt ? 1 : -1));

  // Same lab basis as the API: freshest reading per kind, 30-day maxima for
  // the quantities the engine reasons about, eGFR estimated when possible.
  const latest = new Map<string, MergedVital>();
  for (const v of merged) {
    if (!latest.has(v.kind)) latest.set(v.kind, v);
  }
  const monthAgo = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const maxKind = (kind: string): number | null => {
    let best: number | null = null;
    for (const v of merged) {
      if (v.kind !== kind || v.measuredAt < monthAgo) continue;
      if (best === null || v.value > best) best = v.value;
    }
    return best;
  };
  const creatinine = latest.get('creatinine')?.value ?? null;
  const context = {
    ...emptyClinicalContext(),
    ageYears: patient.ageYears,
    sex: (patient.sex ?? 'unknown') as 'female' | 'male' | 'intersex' | 'unknown',
    weightKg: null,
    allergies: patient.allergies,
    chronicConditions: patient.chronicConditions,
    currentMedications: medications.length > 0 ? medications : patient.currentMedications,
    creatinine,
    hba1c: latest.get('hba1c')?.value ?? null,
    maxSystolic: maxKind('systolic_bp'),
    maxFastingGlucose: maxKind('fasting_glucose'),
  };
  const egfr = estimateEgfr({ ageYears: context.ageYears, sex: context.sex, weightKg: null, creatinine });
  if (egfr !== null) context.egfr = egfr;

  const result = runRuleBasedDecisionSupport({
    diagnosis,
    context,
    currentMedications: medications.length > 0 ? medications : patient.currentMedications,
    knownConditions: patient.chronicConditions,
  });
  const shaped = shapeReview(result);
  const meds = medications.length > 0 ? medications : patient.currentMedications;
  const latestLabs = {
    hba1c: latest.get('hba1c')?.value ?? null,
    creatinine,
    egfr: context.egfr,
    ldl: latest.get('ldl')?.value ?? null,
    triglycerides: latest.get('triglycerides')?.value ?? null,
    systolic: maxKind('systolic_bp'),
    microalbumin: latest.get('microalbumin')?.value ?? null,
    urineAcr: latest.get('urine_acr')?.value ?? null,
    urea: latest.get('urea')?.value ?? null,
  };
  return {
    ...shaped,
    labs: [...latest.values()].map((v) => ({ kind: v.kind, value: v.value, unit: v.unit, measuredAt: v.measuredAt })),
    labGuided: recommendLabGuidedDoses({
      diagnosis,
      conditions: patient.chronicConditions,
      labs: latestLabs,
      biometrics: { ageYears: patient.ageYears, sex: patient.sex ?? 'unknown', weightKg: null },
      currentMedications: meds,
    }),
    lifestyle: recommendLifestyle(
      {
        diagnosis,
        conditions: patient.chronicConditions,
        labs: latestLabs,
        weightKg: patient.weightKg,
        ageYears: patient.ageYears,
      },
      getLang() === 'ar' ? 'ar' : 'en',
    ),
  };
}

/** Warnings, suggestions, and prescribable regimen out of a raw result. */
function shapeReview(result: {
  interactions: { severity: string; drugA: string; drugB: string; clinicalEffect: string }[];
  allergyConflicts: { severity: string; drugName: string; allergen: string; advice: string }[];
  contraindicationNotes: string[];
  dosingAdjustments: { severity: string; drugName: string; note: string }[];
  redFlags: string[];
  monitoring: { label: string; frequency: string; reason: string }[];
  requiredInvestigations: string[];
  suggestedRegimen: {
    genericName: string;
    dose: string;
    frequency: string;
    durationDays: number | null;
    indication: string;
  }[];
}): Omit<ReviewResult, 'labs'> {
  const warnings: string[] = [];
  for (const a of result.allergyConflicts) {
    warnings.push(`Allergy ${a.severity}: ${a.drugName} × ${a.allergen} — ${a.advice}`);
  }
  for (const n of result.contraindicationNotes) warnings.push(n);
  for (const i of result.interactions) {
    if (i.severity === 'contraindicated' || i.severity === 'major') {
      warnings.push(`Interaction ${i.severity}: ${i.drugA} × ${i.drugB} — ${i.clinicalEffect}`);
    }
  }
  for (const d of result.dosingAdjustments) {
    if (d.severity === 'critical') warnings.push(`Dose ${d.severity}: ${d.drugName} — ${d.note}`);
  }
  for (const r of result.redFlags) warnings.push(`Red flag: ${r}`);

  const suggestions: string[] = [];
  for (const m of result.monitoring) suggestions.push(`Monitor ${m.label} (${m.frequency}): ${m.reason}`);
  for (const inv of result.requiredInvestigations) suggestions.push(`Investigate: ${inv}`);

  const severity = warnings.length > 0 ? 'warning' : 'info';
  return {
    severity,
    warnings,
    suggestions,
    regimen: result.suggestedRegimen.map((s) => ({
      drug: s.genericName,
      dose: s.dose || null,
      frequency: s.frequency || null,
      durationDays: s.durationDays,
      instructions: s.indication || null,
    })),
    labGuided: [],
    lifestyle: { targets: [], diet: [], exercise: [] },
    raw: result,
  };
}

export interface InteractionItem {
  drug: string;
  interactingDrug: string;
  severity: string;
  message: string;
}

export function checkInteractions(medications: string): InteractionItem[] {
  const list = medications
    .split(/[,\n;]/)
    .map((s) => s.trim())
    .filter(Boolean);
  return sortInteractions(checkDrugInteractions(list)).map((i) => ({
    drug: i.drugA,
    interactingDrug: i.drugB,
    severity: i.severity,
    message: `${i.clinicalEffect} — ${i.management}`,
  }));
}

// ---------------------------------------------------------------------------
// Dashboard aggregate
// ---------------------------------------------------------------------------

export interface TodaySummary {
  appointments: AppointmentDoc[];
  alerts: AlertDoc[];
  followUps: { due: number; active: number };
  outbox: { queued: number; failed: number };
  patients: { total: number; newThisWeek: number };
}

export async function todaySummary(dateKey: string): Promise<TodaySummary> {
  const appointments = await listAppointments(dateKey, dateKey);
  const now = new Date();
  const upcoming = appointments.filter((a) => Date.parse(a.startsAt) >= now.getTime()).slice(0, 5);
  const alerts = await openAlerts();
  const followUps = await followUpCounts();
  const outbox = await listOutbox();
  const queued = outbox.filter((o) => o.status === 'queued' || o.status === 'sending').length;
  const failed = outbox.filter((o) => o.status === 'failed').length;

  const { db, session } = await context();
  const patientsSnap = await getDocs(query(col(db, session.clinicId, 'patients'), orderBy('createdAt', 'desc'), limit(500)));
  const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();
  let newThisWeek = 0;
  for (const d of patientsSnap.docs) {
    const created = (d.data() as Record<string, unknown>)['createdAt'];
    if (typeof created === 'string' && created >= weekAgo) newThisWeek += 1;
  }
  return {
    appointments: upcoming,
    alerts,
    followUps,
    outbox: { queued, failed },
    patients: { total: patientsSnap.size, newThisWeek },
  };
}
