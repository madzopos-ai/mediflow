/**
 * Firebase-native patient accounts (no API server).
 *
 * Identity = phone + PIN, via the capability id derived in
 * `@mediflow/shared` (`derivePatientAccountId`). The browser holds an
 * anonymous Firebase session only so rules see *a* signed-in user; the uid
 * itself authorises nothing. Session = localStorage (`mf_patient_fb`).
 *
 * This module never touches staff-scoped collections: it reads/writes only
 * `patientAccounts/{id}`, its `records` subtree, and `linkTickets`.
 */

import {
  assertPatientPin,
  canonicalPatientPhone,
  derivePatientAccountId,
} from '@mediflow/shared';
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

import { ensureAnonymous, getFirestoreInstance } from './firebase.js';

const SESSION_KEY = 'mf_patient_fb';

export interface FbPatientSession {
  accountId: string;
  phone: string;
  fullName: string;
}

export interface FbPatientAccount {
  accountId: string;
  phone: string;
  firstName: string;
  lastName: string;
  fullName: string;
  dateOfBirth: string | null;
  address: string | null;
  weightKg: number | null;
  heightCm: number | null;
  bloodGroup: string | null;
  chronicConditions: string[];
  allergies: string[];
  currentMedications: string[];
  pastSurgeries: string[];
  healthNotes: string | null;
  links: Record<string, { patientId: string; linkedAt: string }>;
  createdAt: string;
}

export interface SharedClinicRecord {
  clinicId: string;
  clinicName: string;
  medications: { drug: string; dose: string | null; frequency: string | null }[];
  vitals: { kind: string; value: number; unit: string; measuredAt: string }[];
  visits: { visitType: string; diagnosis: string | null; createdAt: string }[];
  appointments: { startsAt: string; status: string }[];
  requestedTests: { name: string; priority: string; prepNotes: string | null; createdAt: string }[];
  lifestyle: { targets: string[]; diet: string[]; exercise: string[] };
  updatedAt: string;
}

function saveSession(session: FbPatientSession): void {
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

export function getFbPatientSession(): FbPatientSession | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<FbPatientSession>;
    if (!parsed.accountId || !parsed.phone) return null;
    return { accountId: parsed.accountId, phone: parsed.phone, fullName: parsed.fullName ?? '' };
  } catch {
    return null;
  }
}

export function clearFbPatientSession(): void {
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch {
    // Never block sign-out on storage.
  }
}

function toAccount(accountId: string, data: Record<string, unknown>): FbPatientAccount {
  const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
  const nulStr = (v: unknown): string | null => (typeof v === 'string' ? v : null);
  const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);
  const arr = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  const linksRaw = (data['links'] ?? {}) as Record<string, unknown>;
  const links: FbPatientAccount['links'] = {};
  for (const [clinicId, entry] of Object.entries(linksRaw)) {
    if (entry && typeof entry === 'object') {
      const e = entry as Record<string, unknown>;
      if (typeof e['patientId'] === 'string') {
        links[clinicId] = { patientId: e['patientId'] as string, linkedAt: str(e['linkedAt']) };
      }
    }
  }
  return {
    accountId,
    phone: str(data['phone']),
    firstName: str(data['firstName']),
    lastName: str(data['lastName']),
    fullName: str(data['fullName']),
    dateOfBirth: nulStr(data['dateOfBirth']),
    address: nulStr(data['address']),
    weightKg: num(data['weightKg']),
    heightCm: num(data['heightCm']),
    bloodGroup: nulStr(data['bloodGroup']),
    chronicConditions: arr(data['chronicConditions']),
    allergies: arr(data['allergies']),
    currentMedications: arr(data['currentMedications']),
    pastSurgeries: arr(data['pastSurgeries']),
    healthNotes: nulStr(data['healthNotes']),
    links,
    createdAt: str(data['createdAt']),
  };
}

export async function registerFbPatient(input: {
  firstName: string;
  lastName: string;
  phone: string;
  pin: string;
  dateOfBirth?: string | null;
}): Promise<FbPatientSession> {
  await ensureAnonymous();
  const phone = canonicalPatientPhone(input.phone);
  assertPatientPin(input.pin);
  const accountId = await derivePatientAccountId(phone, input.pin);
  const db = getFirestoreInstance();
  const ref = doc(db, 'patientAccounts', accountId);
  const existing = await getDoc(ref);
  if (existing.exists()) {
    throw new Error('registered');
  }
  const now = new Date().toISOString();
  const firstName = input.firstName.trim();
  const lastName = input.lastName.trim();
  await setDoc(ref, {
    phone,
    firstName,
    lastName,
    fullName: `${firstName} ${lastName}`.trim(),
    dateOfBirth: input.dateOfBirth ?? null,
    address: null,
    weightKg: null,
    heightCm: null,
    bloodGroup: null,
    chronicConditions: [],
    allergies: [],
    currentMedications: [],
    pastSurgeries: [],
    healthNotes: null,
    links: {},
    createdAt: now,
    updatedAt: now,
  });
  // Phone directory entry so clinics find this account by number alone.
  await setDoc(doc(db, 'patientPhones', phone.replace(/\D/g, '')), {
    accountId,
    updatedAt: now,
  });
  const session: FbPatientSession = { accountId, phone, fullName: `${firstName} ${lastName}`.trim() };
  saveSession(session);
  return session;
}

export async function signInFbPatient(phone: string, pin: string): Promise<FbPatientSession> {
  await ensureAnonymous();
  const canonical = canonicalPatientPhone(phone);
  assertPatientPin(pin);
  const accountId = await derivePatientAccountId(canonical, pin);
  const db = getFirestoreInstance();
  const snap = await getDoc(doc(db, 'patientAccounts', accountId));
  if (!snap.exists()) {
    // Deliberately generic: must not reveal whether the phone is registered.
    throw new Error('credentials');
  }
  const account = toAccount(accountId, snap.data() as Record<string, unknown>);
  const session: FbPatientSession = { accountId, phone: account.phone, fullName: account.fullName };
  saveSession(session);
  return session;
}

export async function fbPatientAccount(): Promise<FbPatientAccount> {
  const session = getFbPatientSession();
  if (!session) throw new Error('Patient sign-in required.');
  await ensureAnonymous();
  const snap = await getDoc(doc(getFirestoreInstance(), 'patientAccounts', session.accountId));
  if (!snap.exists()) throw new Error('Patient account not found.');
  return toAccount(session.accountId, snap.data() as Record<string, unknown>);
}

export async function updateFbPatientProfile(patch: {
  firstName: string;
  lastName: string;
  dateOfBirth: string | null;
  address: string | null;
  weightKg: number | null;
  heightCm: number | null;
  bloodGroup: string | null;
  chronicConditions: string[];
  allergies: string[];
  currentMedications: string[];
  pastSurgeries: string[];
  healthNotes: string | null;
}): Promise<FbPatientAccount> {
  const session = getFbPatientSession();
  if (!session) throw new Error('Patient sign-in required.');
  await ensureAnonymous();
  const db = getFirestoreInstance();
  const firstName = patch.firstName.trim();
  const lastName = patch.lastName.trim();
  await updateDoc(doc(db, 'patientAccounts', session.accountId), {
    firstName,
    lastName,
    fullName: `${firstName} ${lastName}`.trim(),
    dateOfBirth: patch.dateOfBirth,
    address: patch.address,
    weightKg: patch.weightKg,
    heightCm: patch.heightCm,
    bloodGroup: patch.bloodGroup,
    chronicConditions: patch.chronicConditions,
    allergies: patch.allergies,
    currentMedications: patch.currentMedications,
    pastSurgeries: patch.pastSurgeries,
    healthNotes: patch.healthNotes,
    updatedAt: new Date().toISOString(),
  });
  saveSession({ ...session, fullName: `${firstName} ${lastName}`.trim() });
  return fbPatientAccount();
}

// ---------------------------------------------------------------------------
// Public directory + booking requests (readable without staff auth).
// ---------------------------------------------------------------------------

export interface PublicClinic {
  clinicId: string;
  name: string;
  phone: string | null;
  address: string | null;
  location: { lat: number; lng: number } | null;
  workingHours: { weekday: number; enabled: boolean; start: string; end: string; start2?: string | null; end2?: string | null }[] | null;
  slotDurationMinutes: number;
  visitDurations: { consultation: number; follow_up: number; procedure: number; teleconsult: number } | null;
  reminderSettings: { remind24h: boolean; remind3d: boolean; medsReminders: boolean; bookingConfirm: boolean } | null;
}

export interface PublicDoctor {
  uid: string;
  name: string;
  clinicId: string;
  clinicName: string;
  role: string;
  avatarUrl: string | null;
  specialty: string | null;
  phone: string | null;
}

export async function listPublicClinics(): Promise<PublicClinic[]> {
  const db = getFirestoreInstance();
  const snap = await getDocs(query(collection(db, 'publicClinics'), limit(100)));
  return snap.docs.map((d) => {
    const data = d.data() as Record<string, unknown>;
    const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
    const loc = data['location'] as { lat?: unknown; lng?: unknown } | undefined;
    const lat = typeof loc?.lat === 'number' ? loc.lat : null;
    const lng = typeof loc?.lng === 'number' ? loc.lng : null;
    const wh = data['workingHours'];
    const num = (v: unknown, fallback: number): number =>
      typeof v === 'number' && Number.isFinite(v) ? v : fallback;
    const vd = data['visitDurations'] as Record<string, unknown> | undefined;
    const rs = data['reminderSettings'] as Record<string, unknown> | undefined;
    return {
      clinicId: d.id,
      name: typeof data['name'] === 'string' ? (data['name'] as string) : d.id,
      phone: str(data['phone']),
      address: str(data['address']),
      location: lat !== null && lng !== null ? { lat, lng } : null,
      workingHours: Array.isArray(wh)
        ? (wh as Record<string, unknown>[])
            .filter((x) => typeof x === 'object' && x !== null)
            .map((x) => ({
              weekday: typeof x['weekday'] === 'number' ? (x['weekday'] as number) : -1,
              enabled: x['enabled'] === true,
              start: typeof x['start'] === 'string' ? (x['start'] as string) : '',
              end: typeof x['end'] === 'string' ? (x['end'] as string) : '',
              start2: typeof x['start2'] === 'string' ? (x['start2'] as string) : null,
              end2: typeof x['end2'] === 'string' ? (x['end2'] as string) : null,
            }))
            .filter((x) => x.weekday >= 0 && x.weekday <= 6)
        : null,
      slotDurationMinutes: num(data['slotDurationMinutes'], 30),
      visitDurations:
        vd && typeof vd === 'object'
          ? {
              consultation: num(vd['consultation'], 30),
              follow_up: num(vd['follow_up'], 15),
              procedure: num(vd['procedure'], 60),
              teleconsult: num(vd['teleconsult'], 20),
            }
          : null,
      reminderSettings:
        rs && typeof rs === 'object'
          ? {
              remind24h: rs['remind24h'] !== false,
              remind3d: rs['remind3d'] === true,
              medsReminders: rs['medsReminders'] !== false,
              bookingConfirm: rs['bookingConfirm'] !== false,
            }
          : null,
    };
  });
}

export async function listPublicDoctors(clinicId: string): Promise<PublicDoctor[]> {
  const db = getFirestoreInstance();
  const snap = await getDocs(query(collection(db, 'publicDoctors'), where('clinicId', '==', clinicId), limit(50)));
  return snap.docs.map((d) => {
    const data = d.data() as Record<string, unknown>;
    return {
      uid: d.id,
      name: typeof data['name'] === 'string' ? (data['name'] as string) : '',
      clinicId,
      clinicName: typeof data['clinicName'] === 'string' ? (data['clinicName'] as string) : '',
      role: typeof data['role'] === 'string' ? (data['role'] as string) : '',
      avatarUrl: typeof data['avatarUrl'] === 'string' ? (data['avatarUrl'] as string) : null,
      specialty: typeof data['specialty'] === 'string' ? (data['specialty'] as string) : null,
      phone: typeof data['phone'] === 'string' ? (data['phone'] as string) : null,
    };
  });
}

/** Universal maps link: opens the phone's maps app at the pin. */
export function mapsLink(lat: number, lng: number): string {
  return `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
}

/**
 * File a booking wish with a clinic. The clinic confirms by hand and tells
 * the patient over WhatsApp; the accepted appointment then appears in the
 * shared snapshot under My health.
 */
export async function fileBookingRequest(
  clinicId: string,
  input: { preferredDate: string; note: string | null; startsAt?: string | null },
): Promise<void> {
  const session = getFbPatientSession();
  if (!session) throw new Error('Patient sign-in required.');
  await ensureAnonymous();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.preferredDate)) throw new Error('Pick a day.');
  const startsAt = input.startsAt ?? null;
  if (startsAt && Number.isNaN(Date.parse(startsAt))) throw new Error('Pick a time.');
  await addDoc(collection(getFirestoreInstance(), 'bookingRequests', clinicId, 'items'), {
    patientAccountId: session.accountId,
    patientName: session.fullName,
    phone: session.phone,
    preferredDate: input.preferredDate,
    startsAt,
    note: input.note,
    status: 'requested',
    createdAt: new Date().toISOString(),
  });
}

export interface MyBooking {
  id: string;
  clinicId: string;
  clinicName: string;
  doctorName: string;
  startsAt: string;
  endsAt: string;
  visitType: string;
  note: string | null;
  status: 'confirmed' | 'cancelled' | 'rescheduled' | 'requested' | 'completed';
  createdAt: string;
}

/**
 * Instant booking of a free slot: the slot disappears for other patients on
 * next publish, staff see it in Calendar > direct bookings, and the patient
 * sees it immediately under مواعيدي. No staff click needed.
 *
 * Double-book proof: the doc id IS the slot (one doc per clinic+start), and
 * the write runs in a transaction that aborts when the slot doc already
 * exists — so tapping twice, or two patients racing, yields one booking and
 * a "just booked" error for the loser.
 */
export async function bookDirectSlot(
  clinicId: string,
  clinicName: string,
  input: { startsAt: string; endsAt: string; visitType: string; note: string | null; doctorName?: string },
): Promise<string> {
  const session = getFbPatientSession();
  if (!session) throw new Error('Patient sign-in required.');
  await ensureAnonymous();
  const start = Date.parse(input.startsAt);
  const end = Date.parse(input.endsAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw new Error('Pick a time.');
  if (start < Date.now() - 60_000) throw new Error('That time already passed.');
  const db = getFirestoreInstance();
  const now = new Date().toISOString();
  const slotId = `s${new Date(start).toISOString().replace(/[:.\-]/g, '')}`;
  const payload = {
    patientAccountId: session.accountId,
    patientName: session.fullName,
    phone: session.phone,
    clinicId,
    clinicName,
    doctorName: input.doctorName ?? '',
    startsAt: new Date(start).toISOString(),
    endsAt: new Date(end).toISOString(),
    visitType: input.visitType,
    note: input.note,
    status: 'confirmed',
    createdAt: now,
    updatedAt: now,
  };
  try {
    await runTransaction(db, async (tx) => {
      const existing = await tx.get(doc(db, 'directBookings', clinicId, 'items', slotId));
      if (existing.exists()) throw new Error('slotTaken');
      tx.set(doc(db, 'directBookings', clinicId, 'items', slotId), payload);
      tx.set(doc(db, 'patientAccounts', session.accountId, 'bookings', slotId), {
        ...payload,
        id: slotId,
      });
      // No-PII marker so every other patient hides this time instantly.
      tx.set(doc(db, 'slotClaims', clinicId, 'items', slotId), {
        startsAt: payload.startsAt,
        createdAt: now,
      });
    });
  } catch (error: unknown) {
    if (error instanceof Error && error.message === 'slotTaken') {
      throw new Error('هذا الوقت انحجز للتو — اختار وقت تاني.');
    }
    throw error;
  }
  return slotId;
}

/** Start-times currently claimed by instant bookings (no patient data). */
export async function listTakenSlots(clinicId: string): Promise<string[]> {
  await ensureAnonymous();
  const db = getFirestoreInstance();
  const cutoff = new Date(Date.now() - 16 * 86_400_000).toISOString();
  const snap = await getDocs(query(collection(db, 'slotClaims', clinicId, 'items'), limit(300)));
  return snap.docs
    .filter((d) => {
      const data = d.data() as Record<string, unknown>;
      const created = typeof data['createdAt'] === 'string' ? (data['createdAt'] as string) : '';
      return created >= cutoff;
    })
    .map((d) => {
      const data = d.data() as Record<string, unknown>;
      return typeof data['startsAt'] === 'string' ? (data['startsAt'] as string) : '';
    })
    .filter((s) => s !== '');
}

/** All my direct bookings, newest first — powers مواعيدي + the bell. */
export async function listMyBookings(): Promise<MyBooking[]> {
  const session = getFbPatientSession();
  if (!session) throw new Error('Patient sign-in required.');
  await ensureAnonymous();
  const snap = await getDocs(
    query(
      collection(getFirestoreInstance(), 'patientAccounts', session.accountId, 'bookings'),
      orderBy('startsAt', 'desc'),
      limit(100),
    ),
  );
  return snap.docs.map((d) => {
    const data = d.data() as Record<string, unknown>;
    const st = String(data['status'] ?? 'confirmed');
    return {
      id: d.id,
      clinicId: String(data['clinicId'] ?? ''),
      clinicName: String(data['clinicName'] ?? ''),
      doctorName: String(data['doctorName'] ?? ''),
      startsAt: String(data['startsAt'] ?? ''),
      endsAt: String(data['endsAt'] ?? String(data['startsAt'] ?? '')),
      visitType: String(data['visitType'] ?? 'consultation'),
      note: typeof data['note'] === 'string' ? (data['note'] as string) : null,
      status: (['confirmed', 'cancelled', 'rescheduled', 'requested', 'completed'] as const).includes(st as MyBooking['status'])
        ? (st as MyBooking['status'])
        : 'confirmed',
      createdAt: String(data['createdAt'] ?? ''),
    };
  });
}

/** Patient cancels own booking: frees the slot for others. */
export async function cancelMyBooking(bookingId: string): Promise<void> {
  const session = getFbPatientSession();
  if (!session) throw new Error('Patient sign-in required.');
  await ensureAnonymous();
  const db = getFirestoreInstance();
  const now = new Date().toISOString();
  const mine = await getDoc(doc(db, 'patientAccounts', session.accountId, 'bookings', bookingId));
  if (!mine.exists()) throw new Error('Booking not found.');
  const data = mine.data() as Record<string, unknown>;
  const clinicId = String(data['clinicId'] ?? '');
  await updateDoc(doc(db, 'patientAccounts', session.accountId, 'bookings', bookingId), {
    status: 'cancelled',
    updatedAt: now,
  });
  if (clinicId) {
    await updateDoc(doc(db, 'directBookings', clinicId, 'items', bookingId), {
      status: 'cancelled',
      updatedAt: now,
    }).catch(() => undefined);
    // Free the time for other patients instantly.
    const { deleteDoc } = await import('firebase/firestore');
    await deleteDoc(doc(db, 'slotClaims', clinicId, 'items', bookingId)).catch(() => undefined);
  }
}

export interface PublicSlotDay {
  dateKey: string;
  slots: { startsAt: string; localStart: string }[];
}

/** Published free slots for one clinic (no auth needed, no index needed). */
export async function listClinicSlots(clinicId: string): Promise<PublicSlotDay[]> {
  const db = getFirestoreInstance();
  const today = new Date().toISOString().slice(0, 10);
  const snap = await getDocs(query(collection(db, 'publicSlots', clinicId, 'days'), limit(21)));
  return snap.docs
    .map((d) => {
      const data = d.data() as Record<string, unknown>;
      const slots = Array.isArray(data['slots'])
        ? (data['slots'] as Record<string, unknown>[])
            .filter((s) => typeof s === 'object' && s !== null)
            .map((s) => ({
              startsAt: typeof s['startsAt'] === 'string' ? (s['startsAt'] as string) : '',
              localStart: typeof s['localStart'] === 'string' ? (s['localStart'] as string) : '',
            }))
            .filter((s) => s.startsAt !== '' && s.startsAt >= `${today}T00:00:00.000Z`)
        : [];
      return { dateKey: d.id, slots };
    })
    .filter((d) => d.dateKey >= today && d.slots.length > 0)
    .sort((a, b) => (a.dateKey < b.dateKey ? -1 : 1))
    .slice(0, 7);
}

export async function mySharedRecords(): Promise<SharedClinicRecord[]> {  const session = getFbPatientSession();
  if (!session) throw new Error('Patient sign-in required.');
  await ensureAnonymous();
  const snap = await getDocs(
    query(
      collection(getFirestoreInstance(), 'patientAccounts', session.accountId, 'records'),
      orderBy('updatedAt', 'desc'),
      limit(20),
    ),
  );
  return snap.docs.map((d) => {
    const data = d.data() as Record<string, unknown>;
    const strArr = (v: unknown): string[] =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
    const asStrings = (v: unknown): { drug: string; dose: string | null; frequency: string | null }[] =>
      Array.isArray(v)
        ? v.map((i) => {
            const item = (i ?? {}) as Record<string, unknown>;
            return {
              drug: String(item['drug'] ?? ''),
              dose: typeof item['dose'] === 'string' ? (item['dose'] as string) : null,
              frequency: typeof item['frequency'] === 'string' ? (item['frequency'] as string) : null,
            };
          })
        : [];
    return {
      clinicId: d.id,
      clinicName: typeof data['clinicName'] === 'string' ? (data['clinicName'] as string) : d.id,
      medications: asStrings(data['medications']),
      vitals: Array.isArray(data['vitals']) ? (data['vitals'] as SharedClinicRecord['vitals']) : [],
      visits: Array.isArray(data['visits']) ? (data['visits'] as SharedClinicRecord['visits']) : [],
      appointments: Array.isArray(data['appointments'])
        ? (data['appointments'] as SharedClinicRecord['appointments'])
        : [],
      requestedTests: Array.isArray(data['requestedTests'])
        ? (data['requestedTests'] as Record<string, unknown>[])
            .filter((x) => typeof x === 'object' && x !== null)
            .map((x) => ({
              name: String(x['name'] ?? ''),
              priority: String(x['priority'] ?? 'routine'),
              prepNotes: typeof x['prepNotes'] === 'string' ? (x['prepNotes'] as string) : null,
              createdAt: String(x['createdAt'] ?? ''),
            }))
        : [],
      lifestyle:
        data['lifestyle'] && typeof data['lifestyle'] === 'object'
          ? {
              targets: strArr((data['lifestyle'] as Record<string, unknown>)['targets']),
              diet: strArr((data['lifestyle'] as Record<string, unknown>)['diet']),
              exercise: strArr((data['lifestyle'] as Record<string, unknown>)['exercise']),
            }
          : { targets: [], diet: [], exercise: [] },
      updatedAt: typeof data['updatedAt'] === 'string' ? (data['updatedAt'] as string) : '',
    };
  });
}

// ---------------------------------------------------------------------------
// Patient-uploaded labs/photos + OCR-confirmed readings (My health).
// Images are resized client-side and stored as data URLs: no bucket needed,
// and the linked clinic reads them through the patient's link.
// ---------------------------------------------------------------------------

export interface PatientUpload {
  id: string;
  fileName: string;
  dataUrl: string;
  createdAt: string;
}

export interface PatientVital {
  id: string;
  kind: string;
  value: number;
  unit: string;
  measuredAt: string;
}

function resizeImageToDataUrl(file: Blob, maxSide = 1024): Promise<string> {
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
        resolve(canvas.toDataURL('image/jpeg', 0.85));
      } catch (error) {
        URL.revokeObjectURL(url);
        reject(error);
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Could not read the image.'));
    };
    img.src = url;
  });
}

export async function uploadPatientFile(file: File, title: string | null): Promise<PatientUpload> {
  const session = getFbPatientSession();
  if (!session) throw new Error('Patient sign-in required.');
  if (!file.type.startsWith('image/')) throw new Error('Images only for now.');
  if (file.size > 15 * 1024 * 1024) throw new Error('Image must be under 15 MB.');
  await ensureAnonymous();
  const db = getFirestoreInstance();
  const dataUrl = await resizeImageToDataUrl(file);
  const now = new Date().toISOString();
  const ref = await addDoc(collection(db, 'patientAccounts', session.accountId, 'uploads'), {
    fileName: title && title.trim() !== '' ? title.trim() : file.name,
    dataUrl,
    createdAt: now,
  });
  return { id: ref.id, fileName: file.name, dataUrl, createdAt: now };
}

export async function listPatientUploads(): Promise<PatientUpload[]> {
  const session = getFbPatientSession();
  if (!session) throw new Error('Patient sign-in required.');
  await ensureAnonymous();
  const snap = await getDocs(
    query(
      collection(getFirestoreInstance(), 'patientAccounts', session.accountId, 'uploads'),
      orderBy('createdAt', 'desc'),
      limit(30),
    ),
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

export async function savePatientVitals(items: { kind: string; value: number; unit: string }[]): Promise<number> {  const session = getFbPatientSession();
  if (!session) throw new Error('Patient sign-in required.');
  if (items.length === 0) return 0;
  await ensureAnonymous();
  const db = getFirestoreInstance();
  const now = new Date().toISOString();
  for (const item of items.slice(0, 20)) {
    await addDoc(collection(db, 'patientAccounts', session.accountId, 'myVitals'), {
      kind: item.kind,
      value: item.value,
      unit: item.unit,
      measuredAt: now,
      createdAt: now,
    });
  }
  return Math.min(items.length, 20);
}

export async function listPatientVitals(): Promise<PatientVital[]> {
  const session = getFbPatientSession();
  if (!session) throw new Error('Patient sign-in required.');
  await ensureAnonymous();
  const snap = await getDocs(
    query(
      collection(getFirestoreInstance(), 'patientAccounts', session.accountId, 'myVitals'),
      orderBy('measuredAt', 'desc'),
      limit(50),
    ),
  );
  return snap.docs.map((d) => {
    const data = d.data() as Record<string, unknown>;
    return {
      id: d.id,
      kind: String(data['kind'] ?? ''),
      value: Number(data['value'] ?? 0),
      unit: String(data['unit'] ?? ''),
      measuredAt: typeof data['measuredAt'] === 'string' ? (data['measuredAt'] as string) : '',
    };
  });
}

// ---------------------------------------------------------------------------
// دوائي: dose-taken log. Each "taken" press stores drug + timestamp so the
// patient sees which dose on which day is done.
// ---------------------------------------------------------------------------

export interface MedTake {
  id: string;
  drug: string;
  dose: string | null;
  clinicId: string;
  clinicName: string;
  takenAt: string;
}

export async function logMedTake(input: {
  drug: string;
  dose: string | null;
  clinicId: string;
  clinicName: string;
}): Promise<void> {
  const session = getFbPatientSession();
  if (!session) throw new Error('Patient sign-in required.');
  if (!input.drug.trim()) throw new Error('Pick a medication.');
  await ensureAnonymous();
  await addDoc(collection(getFirestoreInstance(), 'patientAccounts', session.accountId, 'medTakes'), {
    drug: input.drug.trim(),
    dose: input.dose,
    clinicId: input.clinicId,
    clinicName: input.clinicName,
    takenAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
  });
}

export async function listMedTakes(max = 60): Promise<MedTake[]> {
  const session = getFbPatientSession();
  if (!session) throw new Error('Patient sign-in required.');
  await ensureAnonymous();
  const snap = await getDocs(
    query(
      collection(getFirestoreInstance(), 'patientAccounts', session.accountId, 'medTakes'),
      orderBy('takenAt', 'desc'),
      limit(max),
    ),
  );
  return snap.docs.map((d) => {
    const data = d.data() as Record<string, unknown>;
    return {
      id: d.id,
      drug: String(data['drug'] ?? ''),
      dose: typeof data['dose'] === 'string' ? (data['dose'] as string) : null,
      clinicId: String(data['clinicId'] ?? ''),
      clinicName: String(data['clinicName'] ?? ''),
      takenAt: typeof data['takenAt'] === 'string' ? (data['takenAt'] as string) : '',
    };
  });
}
