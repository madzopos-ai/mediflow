/**
 * Data facade: one function per screen, two backends.
 *
 * Customer builds carry a Firebase config and talk to Firestore (offline
 * first, per-clinic rules). Local development has no Firebase project and
 * keeps using the API. Screens never know which one is active.
 */

import { OfflineQueuedError, api, getToken, readQueue } from './api.js';

/** Fresh staff profile state for the onboarding gate (never trust the token). */
export async function staffMe(): Promise<{
  profileComplete: boolean;
  specialty: string | null;
  role?: string;
}> {
  return api('GET', '/auth/me');
}

export interface UiStaff {
  id: string;
  email: string;
  fullName: string;
  role: string;
  specialty: string | null;
  phone: string | null;
  isActive: boolean;
  lastLoginAt: string | null;
}

export async function staffList(): Promise<UiStaff[]> {
  const data = await api<{ items: UiStaff[] }>('GET', '/staff');
  return data.items ?? [];
}

export async function staffCreate(input: {
  email: string;
  password: string;
  fullName: string;
  role: string;
  specialty?: string | null;
  phone?: string | null;
}): Promise<void> {
  await api('POST', '/staff', input);
}

export async function staffUpdate(
  id: string,
  input: { role?: string; specialty?: string | null; isActive?: boolean; password?: string },
): Promise<void> {
  await api('PATCH', `/staff/${id}`, input);
}

// ---------------------------------------------------------------------------
// Reseller console (is_reseller sessions only).
// ---------------------------------------------------------------------------

export interface UiPendingPractice {
  email: string;
  fullName: string;
  role: string;
  clinicId: string;
  clinic: string;
  clinicKind: string;
  createdAt: string;
}

export interface UiResellerClinic {
  id: string;
  name: string;
  kind: string;
  slug: string;
  phone: string | null;
  email: string | null;
  plan: string;
  subscriptionStatus: string;
  subscribedAt: string | null;
  expiresAt: string | null;
  isActive: boolean;
  createdAt: string;
  ownerEmail: string | null;
  patientCount: number;
  staffCount: number;
  collectedMinor: number;
}

export const resellerPending = (): Promise<{ items: UiPendingPractice[] }> => api('GET', '/reseller/pending');
export const resellerApprove = (clinicId: string): Promise<unknown> => api('POST', '/reseller/approve', { clinicId });
export const resellerSuspend = (clinicId: string): Promise<unknown> => api('POST', '/reseller/suspend', { clinicId });
export const resellerClinics = (): Promise<{ items: UiResellerClinic[] }> => api('GET', '/reseller/clinics');

export interface UiClinicStatement {
  clinic: UiResellerClinic & { ownerName: string | null };
  collectedMinor: number;
  receipts: { id: string; amountMinor: number; periodStart: string | null; periodEnd: string | null; reference: string | null; note: string | null; receivedAt: string }[];
}

export const resellerStatement = (clinicId: string): Promise<UiClinicStatement> =>
  api('GET', `/reseller/clinics/${clinicId}/statement`);

export const resellerSubscription = (input: {
  clinicId: string;
  plan: string;
  status?: string;
  subscribedAt?: string | null;
  expiresAt?: string | null;
}): Promise<unknown> => api('POST', '/reseller/subscription', input);

export const resellerCollect = (input: {
  clinicId: string;
  amountMinor: number;
  periodStart?: string | null;
  periodEnd?: string | null;
  reference?: string | null;
  note?: string | null;
}): Promise<unknown> => api('POST', '/reseller/collections', input);

// ---------------------------------------------------------------------------
// Clinic setup (owners configure their own practice).
// ---------------------------------------------------------------------------

export interface UiClinicProfile {
  name: string;
  nameAr: string | null;
  country: string | null;
  currency: string;
  phone: string | null;
  email: string | null;
  address: string | null;
  logoUrl: string | null;
  timeZone: string;
}

export const clinicProfile = (): Promise<UiClinicProfile> => api('GET', '/clinic');
export const clinicSaveProfile = (input: Record<string, string | null>): Promise<unknown> =>
  api('PATCH', '/clinic', input);

export interface UiWorkingDay {
  weekday: number;
  enabled: boolean;
  start: string;
  end: string;
  breaks: { start: string; end: string; label: string }[];
}

export interface UiSchedule {
  workingHours: UiWorkingDay[];
  slotDurationMinutes: number;
  bufferMinutes: number;
  slotIntervalMinutes: number;
  maxDailyAppointments: number | null;
}

export const clinicSchedule = (): Promise<UiSchedule> => api('GET', '/clinic/schedule');
export const clinicSaveSchedule = (schedule: UiSchedule): Promise<unknown> =>
  api('PUT', '/clinic/schedule', schedule);

export const clinicSettings = (): Promise<{
  booking: { minNoticeHours: number; maxAdvanceDays: number };
  features: { publicBookingLink: boolean; requireDepositOnBooking: boolean };
}> => api('GET', '/clinic/settings');

export const clinicSaveSettings = (input: {
  booking?: { minNoticeHours?: number; maxAdvanceDays?: number };
  features?: { publicBookingLink?: boolean; requireDepositOnBooking?: boolean };
}): Promise<unknown> => api('PUT', '/clinic/settings', input);

let specialtyCache: string | null | undefined;

/** The signed-in doctor's specialty, for scoping drugs and labs first. */
export async function staffSpecialty(): Promise<string | null> {
  if (specialtyCache !== undefined) return specialtyCache;
  try {
    const me = await staffMe();
    specialtyCache = me.specialty;
  } catch {
    specialtyCache = null;
  }
  return specialtyCache;
}

type StoreModule = typeof import('./store.js');

let modePromise: Promise<boolean> | null = null;

function useFirestore(): Promise<boolean> {
  if (!modePromise) {
    modePromise = import('./firebase.js').then((fb) => fb.isFirebaseConfigured());
  }
  return modePromise;
}

async function store(): Promise<StoreModule> {
  return import('./store.js');
}

/** True when the build carries a Firebase config (production customer mode). */
let firebaseModeCache: boolean | null = null;

export async function isFirebaseMode(): Promise<boolean> {
  if (firebaseModeCache !== null) return firebaseModeCache;
  firebaseModeCache = (await import('./firebase.js').then((fb) => fb.isFirebaseConfigured())) ?? false;
  return firebaseModeCache;
}

// ---------------------------------------------------------------------------
// Reseller console (Firebase mode only - API mode uses reseller* below).
// ---------------------------------------------------------------------------

export interface UiPendingUser {
  uid: string;
  name: string;
  email: string;
  clinicId: string;
  createdAt: string | null;
}

export interface UiClinicSummary {
  id: string;
  name: string;
  ownerUid: string | null;
  createdAt: string | null;
}

export async function fbPendingUsers(): Promise<UiPendingUser[]> {
  return (await store()).listPendingUsers();
}

export async function fbApproveUser(uid: string): Promise<void> {
  await (await store()).approveUser(uid);
}

export async function fbAllClinics(): Promise<UiClinicSummary[]> {
  return (await store()).listAllClinics();
}

export interface UiActivationCode {
  code: string;
  note: string | null;
  usedBy: string | null;
  createdAt: string;
}

export const fbListActivationCodes = async (): Promise<UiActivationCode[]> =>
  (await store()).listActivationCodes();

export const fbCreateActivationCode = async (note: string | null): Promise<string> =>
  (await store()).createActivationCode(note);

export const fbRevokeActivationCode = async (code: string): Promise<void> => {
  await (await store()).revokeActivationCode(code);
};

export interface UiClinicStaffRow {
  uid: string;
  name: string;
  email: string;
  role: string;
  status: string;
  disabled: boolean;
}

export const fbClinicStaff = async (clinicId: string): Promise<UiClinicStaffRow[]> =>
  (await store()).clinicStaff(clinicId);

export interface UiClinicSubscription {
  plan: string | null;
  pricePerDoctorMinor: number;
  currency: string;
  doctorLimit: number;
  subscribedAt: string | null;
  expiresAt: string | null;
  disabled: boolean;
}

export const fbReadClinicSubscription = async (clinicId: string): Promise<UiClinicSubscription> =>
  (await store()).readClinicSubscription(clinicId);

export const fbSaveClinicSubscription = async (
  clinicId: string,
  patch: {
    plan: string | null;
    pricePerDoctorMinor: number;
    currency: string;
    doctorLimit: number;
    subscribedAt: string | null;
    expiresAt: string | null;
  },
): Promise<void> => {
  await (await store()).saveClinicSubscription(clinicId, patch);
};

export interface UiSubscriptionReceipt {
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

export const fbRecordSubscriptionPayment = async (
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
): Promise<void> => {
  await (await store()).recordSubscriptionPayment(clinicId, input);
};

export const fbClinicSubscriptionPayments = async (clinicId: string): Promise<UiSubscriptionReceipt[]> =>
  (await store()).clinicSubscriptionPayments(clinicId);

export const fbSetClinicDisabled = async (clinicId: string, disabled: boolean): Promise<void> => {
  await (await store()).setClinicDisabled(clinicId, disabled);
};

export const fbSetUserDisabled = async (uid: string, disabled: boolean): Promise<void> => {
  await (await store()).setUserDisabled(uid, disabled);
};

// ---------------------------------------------------------------------------
// Patients
// ---------------------------------------------------------------------------

export interface UiPatient {
  id: string;
  fullName: string;
  mrn: string;
  phone: string;
  whatsappOptIn: boolean;
}

export async function patientsList(search: string): Promise<UiPatient[]> {
  if (await useFirestore()) {
    return (await store()).listPatients(search);
  }
  // The API filters on `q` (search_blob); a wrong key is silently ignored and
  // the picker would show unfiltered rows.
  const q = search ? `?q=${encodeURIComponent(search)}&limit=50` : '?limit=50';
  const data = await api<{ items?: UiPatient[] }>('GET', `/patients${q}`);
  return data.items ?? [];
}

export async function patientsCreate(
  firstName: string,
  lastName: string,
  phone: string,
  extra: { dateOfBirth: string; address: string; heightCm: number; weightKg: number },
): Promise<{ id: string }> {
  if (await useFirestore()) {
    return { id: await (await store()).createPatient({ firstName, lastName, phone, ...extra }) };
  }
  return api<{ id: string }>('POST', '/patients', { firstName, lastName, phone, ...extra });
}

export async function patientUpdate(
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
  if (await useFirestore()) {
    await (await store()).updatePatient(id, input);
    return;
  }
  await api('PATCH', `/patients/${id}`, input);
}

export interface UiOverview {
  patient: {
    id: string;
    fullName: string;
    firstName: string;
    lastName: string;
    mrn: string;
    phone: string;
    whatsappOptIn: boolean;
    ageYears: number | null;
    dateOfBirth: string | null;
    heightCm: number | null;
    weightKg: number | null;
    address: string | null;
    city: string | null;
    insurerId: string | null;
    insurerPolicyNo: string | null;
    /** Firebase patient-app account id, when the patient linked their app. */
    patientAppId?: string | null;
  };
  vitals: { kind: string; value: number; unit: string; measuredAt: string }[];
  visits: { id: string; visitType: string; chiefComplaint: string | null; createdAt: string }[];
  appointments: { id: string; startsAt: string; status: string }[];
  alerts: { id: string; severity: string; title: string }[];
  invoices: { id: string; status: string; totalMinor: number; currency: string }[];
}

export async function patientOverview(id: string): Promise<UiOverview> {
  if (await useFirestore()) {
    const s = await store();
    const [patient, vitals, visits, appointments, alerts, invoices] = await Promise.all([
      s.getPatient(id),
      s.latestVitals(id),
      s.visitsForPatient(id),
      s.appointmentsForPatient(id),
      s.alertsForPatient(id),
      s.invoicesForPatient(id),
    ]);
    if (!patient) throw new Error('Patient not found.');
    return {
      patient: {
        id: patient.id,
        fullName: patient.fullName,
        firstName: patient.firstName,
        lastName: patient.lastName,
        mrn: patient.mrn,
        phone: patient.phone,
        whatsappOptIn: patient.whatsappOptIn,
        ageYears: patient.ageYears,
        dateOfBirth: patient.dateOfBirth,
        heightCm: patient.heightCm,
        weightKg: patient.weightKg,
        address: patient.address,
        city: patient.city,
        insurerId: patient.insurerId,
        insurerPolicyNo: patient.insurerPolicyNo,
        patientAppId: patient.patientAppId ?? null,
      },
      vitals: vitals.map((v) => ({ kind: v.kind, value: v.value, unit: v.unit, measuredAt: v.measuredAt })),
      visits,
      appointments: appointments.map((a) => ({ id: a.id, startsAt: a.startsAt, status: a.status })),
      alerts,
      invoices,
    };
  }
  return api<UiOverview>('GET', `/patients/${id}/overview`);
}

export async function patientConsent(id: string, optIn: boolean): Promise<void> {
  if (await useFirestore()) {
    await (await store()).setPatientConsent(id, optIn);
    return;
  }
  await api('POST', `/patients/${id}/${optIn ? 'opt-in' : 'opt-out'}`, {});
}

export async function recordVital(patientId: string, kind: string, value: number): Promise<void> {
  if (await useFirestore()) {
    await (await store()).recordVital(patientId, kind, value);
    return;
  }
  await api('POST', '/vitals', { patientId, readings: [{ kind, value }] });
}

export interface UiVisit {
  id: string;
  visitType: string;
  chiefComplaint: string | null;
  diagnosis: string | null;
  plan: string | null;
  notes: string | null;
  createdAt: string;
}

export async function visitsAll(patientId: string): Promise<UiVisit[]> {
  if (await useFirestore()) {
    return (await store()).visitsForPatient(patientId, 100);
  }
  const data = await api<{ items?: { id: string; visit_type?: string; visitType?: string; chief_complaint?: string; chiefComplaint?: string | null; diagnosis?: string | null; plan?: string | null; notes?: string | null; created_at?: string; createdAt?: string }[] }>(
    'GET',
    `/visits?patientId=${encodeURIComponent(patientId)}&limit=100`,
  );
  return (data.items ?? []).map((v) => ({
    id: v.id,
    visitType: v.visitType ?? v.visit_type ?? '',
    chiefComplaint: v.chiefComplaint ?? v.chief_complaint ?? null,
    diagnosis: v.diagnosis ?? null,
    plan: v.plan ?? null,
    notes: v.notes ?? null,
    createdAt: v.createdAt ?? v.created_at ?? '',
  }));
}

export async function visitCreate(input: {
  patientId: string;
  visitType: string;
  chiefComplaint?: string | null;
  diagnosis?: string | null;
  plan?: string | null;
  notes?: string | null;
}): Promise<void> {
  if (await useFirestore()) {
    await (await store()).createVisit(input);
    return;
  }
  await api('POST', '/visits', {
    patientId: input.patientId,
    visitType: input.visitType,
    ...(input.chiefComplaint ? { chiefComplaint: input.chiefComplaint } : {}),
    ...(input.diagnosis ? { diagnosis: input.diagnosis } : {}),
    ...(input.plan ? { plan: input.plan } : {}),
    ...(input.notes ? { notes: input.notes } : {}),
  });
}

export interface UiRequestedTest {
  id: string;
  name: string;
  status: string;
  isShared?: boolean;
  priority?: string | null;
  prepNotes?: string | null;
  documentId: string | null;
  notes: string | null;
  createdAt: string;
}

export async function testsOrder(
  patientId: string,
  name: string,
  notes: string | null,
  extra?: { priority?: string | null; prepNotes?: string | null },
): Promise<void> {
  if (await useFirestore()) {
    await (await store()).orderTest(patientId, name, notes, extra);
    return;
  }
  await api('POST', '/requested-tests', {
    patientId,
    name,
    ...(notes ? { notes } : {}),
    ...(extra?.priority ? { priority: extra.priority } : {}),
    ...(extra?.prepNotes ? { prepNotes: extra.prepNotes } : {}),
  });
}

export async function testsList(patientId: string, status?: string): Promise<UiRequestedTest[]> {
  if (await useFirestore()) {
    return (await store()).listRequestedTests(patientId, status);
  }
  const data = await api<{ items?: UiRequestedTest[] }>(
    'GET',
    `/requested-tests?patientId=${encodeURIComponent(patientId)}${status ? `&status=${status}` : ''}&limit=100`,
  );
  return data.items ?? [];
}

export async function testComplete(id: string, documentId: string | null): Promise<void> {
  if (await useFirestore()) {
    await (await store()).completeRequestedTest(id, documentId);
    return;
  }
  await api('PATCH', `/requested-tests/${id}`, { status: 'done', documentId });
}

export interface UiPrescriptionItem {
  drug: string;
  dose?: string | null;
  frequency?: string | null;
  durationDays?: number | null;
  instructions?: string | null;
}

export interface UiPrescription {
  id: string;
  items: UiPrescriptionItem[];
  diet: string[];
  exercise: string[];
  notes: string | null;
  status: string;
  isShared?: boolean;
  createdAt: string;
}

export async function rxCreate(input: {
  patientId: string;
  visitId?: string | null;
  items: UiPrescriptionItem[];
  diet: string[];
  exercise: string[];
  notes?: string | null;
}): Promise<void> {
  if (await useFirestore()) {
    await (await store()).createPrescription(input);
    return;
  }
  await api('POST', '/prescriptions', input);
}

export async function rxList(patientId: string, status?: string): Promise<UiPrescription[]> {
  if (await useFirestore()) {
    return (await store()).listPrescriptions(patientId, status);
  }
  const data = await api<{ items?: UiPrescription[] }>(
    'GET',
    `/prescriptions?patientId=${encodeURIComponent(patientId)}${status ? `&status=${status}` : ''}&limit=50`,
  );
  return data.items ?? [];
}

// ---------------------------------------------------------------------------
// Patient app (API mode): PIN access issued by the clinic, self-service after.
// ---------------------------------------------------------------------------

const PATIENT_TOKEN_KEY = 'mf_patient_token';

export function getPatientToken(): string | null {
  return localStorage.getItem(PATIENT_TOKEN_KEY);
}

export function clearPatientToken(): void {
  localStorage.removeItem(PATIENT_TOKEN_KEY);
}

export async function accessCode(patientId: string): Promise<string> {
  const data = await api<{ code: string }>('POST', `/patients/${patientId}/access-code`, {});
  return data.code;
}

/**
 * Firebase-mode patient import (staff side): find the registered app account
 * by phone, create/prefill the local file from the patient's own health
 * profile, and link both sides. Returns the local patient id to open.
 */
export async function fbImportPatient(
  phone: string,
): Promise<{ localId: string; fullName: string; phone: string }> {
  const { localId, account } = await (await store()).importPatientAccountByPhone(phone);
  return { localId, fullName: account.fullName, phone: account.phone };
}

export async function fbShareSnapshot(patientId: string): Promise<string> {
  return (await store()).shareSnapshotToPatientApp(patientId);
}

/** Approve one draft prescription (visible on next share). */
export async function fbApprovePrescription(id: string): Promise<void> {
  await (await store()).approvePrescription(id);
}

/** Payment/share gate: approve all drafts + unshared tests, then sync. */
export async function fbApproveAllAndShare(patientId: string): Promise<{ prescriptions: number; tests: number }> {
  return (await store()).approveAllAndShare(patientId);
}

export interface UiPatientAppUpload {
  id: string;
  fileName: string;
  dataUrl: string;
  createdAt: string;
}

export interface UiPatientAppVital {
  kind: string;
  value: number;
  unit: string;
  measuredAt: string;
}

export async function fbPatientUploads(appId: string): Promise<UiPatientAppUpload[]> {
  return (await store()).patientAppUploads(appId);
}

export async function fbPatientVitals(appId: string): Promise<UiPatientAppVital[]> {
  return (await store()).patientAppVitals(appId);
}

export interface UiDoctorInvite {
  code: string;
  usedBy: string | null;
  createdAt: string;
}

export async function fbCreateDoctorInvite(): Promise<string> {
  return (await store()).createDoctorInvite();
}

export async function fbListMyInvites(): Promise<UiDoctorInvite[]> {
  return (await store()).listMyInvites();
}

export async function fbRevokeDoctorInvite(code: string): Promise<void> {
  await (await store()).revokeDoctorInvite(code);
}

export interface UiBookingRequest {
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

export async function fbListBookingRequests(): Promise<UiBookingRequest[]> {
  return (await store()).listBookingRequests();
}

export async function fbAcceptBookingRequest(requestId: string, startsAt: string): Promise<string> {
  return (await store()).acceptBookingRequest(requestId, startsAt);
}

export async function fbDeclineBookingRequest(requestId: string): Promise<void> {
  await (await store()).declineBookingRequest(requestId);
}

/** Republish free slots (staff devices, best-effort, silent on failure). */
export async function fbPublishAvailability(): Promise<void> {
  try {
    await (await store()).publishAvailability();
  } catch {
    // Publishing must never break the screen that triggered it.
  }
}

export async function fbGetBookingSettings(): Promise<{
  slotDurationMinutes: number;
  visitDurations: { consultation: number; follow_up: number; procedure: number; teleconsult: number };
  reminderSettings: { remind24h: boolean; remind3d: boolean; medsReminders: boolean; bookingConfirm: boolean };
}> {
  return (await store()).myBookingSettings();
}

export async function fbSaveBookingSettings(input: {
  slotDurationMinutes: number;
  visitDurations: { consultation: number; follow_up: number; procedure: number; teleconsult: number };
  reminderSettings: { remind24h: boolean; remind3d: boolean; medsReminders: boolean; bookingConfirm: boolean };
}): Promise<void> {
  await (await store()).saveBookingSettings(input);
  await fbPublishAvailability();
}

export async function fbListDirectBookings(): Promise<
  { id: string; patientName: string; phone: string; startsAt: string; endsAt: string; visitType: string; doctorName: string; status: string }[]
> {
  return (await store()).listDirectBookings();
}

export async function fbCancelDirectBooking(bookingId: string): Promise<void> {
  await (await store()).cancelDirectBooking(bookingId);
}

/** Publish directory cards (called after profile save + at staff login). */
export async function fbSyncDirectory(): Promise<void> {
  const s = await store();
  await s.syncPublicClinic();
  await s.syncMyDirectoryEntry().catch(() => undefined);
}

export interface UiDirectoryEntry {
  name: string;
  avatarUrl: string | null;
  clinicId: string;
  clinicName: string;
  specialty: string | null;
  phone: string | null;
}

export async function fbMyDirectoryEntry(): Promise<UiDirectoryEntry | null> {
  return (await store()).getMyDirectoryEntry();
}

export async function fbSaveMyDirectoryDetails(input: { specialty: string | null; phone: string | null }): Promise<void> {
  await (await store()).saveMyDirectoryDetails(input);
}

export async function fbUploadDirectoryPhoto(file: Blob): Promise<string> {
  return (await store()).uploadMyDirectoryPhoto(file);
}

export async function fbSaveClinicLocation(lat: number, lng: number): Promise<void> {
  await (await store()).saveClinicLocation(lat, lng);
}

export interface FbWorkingDay {
  weekday: number;
  enabled: boolean;
  start: string;
  end: string;
}

export async function fbMyWorkingHours(): Promise<FbWorkingDay[] | null> {
  return (await store()).myWorkingHours();
}

export async function fbSaveMyWorkingHours(days: FbWorkingDay[]): Promise<void> {
  await (await store()).saveMyWorkingHours(days);
  // Saving hours must immediately republish slots, otherwise patients keep
  // seeing "no published times" until staff happens to open the calendar.
  try {
    await (await store()).publishAvailability();
  } catch {
    // Publishing is best-effort: hours are already saved.
  }
}

export async function fbClinicLocation(): Promise<{ lat: number; lng: number } | null> {
  return (await store()).clinicLocation();
}

export async function patientLogin(phone: string, code: string): Promise<void> {
  const base = (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:4000';
  const response = await fetch(`${base}/auth/patient`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ phone, code }),
  });
  if (!response.ok) throw new Error('Incorrect phone number or code.');
  const data = (await response.json()) as { token: string };
  localStorage.setItem(PATIENT_TOKEN_KEY, data.token);
}

async function patApi<T>(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown): Promise<T> {
  const token = getPatientToken();
  if (!token) throw new Error('Patient sign-in required.');
  const base = (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:4000';
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      authorization: `Bearer ${token}`,
    },
    body: body === undefined ? null : JSON.stringify(body),
  });
  if (response.status === 401) {
    clearPatientToken();
    window.location.hash = '#/login';
    throw new Error('Session expired.');
  }
  if (!response.ok) {
    let message = `Request failed (${response.status}).`;
    try {
      const parsed = (await response.json()) as { error?: { message?: string } };
      if (parsed.error?.message) message = parsed.error.message;
    } catch {
      // Keep the generic message.
    }
    throw new Error(message);
  }
  return (await response.json()) as T;
}

export const patientMe = (): Promise<{ id: string; fullName: string; phone: string }> =>
  patApi('GET', '/patient/me');

export const patientAppointments = (): Promise<{
  items: { id: string; startsAt: string; status: string }[];
}> => patApi('GET', '/patient/me/appointments');

export const patientBook = (startsAt: string, reason?: string | null): Promise<unknown> =>
  patApi('POST', '/patient/me/appointments', { startsAt, ...(reason ? { reason } : {}) });

export const patientCancelAppointment = (id: string): Promise<unknown> =>
  patApi('POST', `/patient/me/appointments/${id}/cancel`, {});

export const patientPrescriptions = (): Promise<{ items: UiPrescription[] }> =>
  patApi('GET', '/patient/me/prescriptions');

export const patientReminders = (): Promise<{
  items: { id: string; scheduledFor: string; template: string; appointmentStartsAt: string | null }[];
}> => patApi('GET', '/patient/me/reminders');

export const patientTests = (): Promise<{ items: UiRequestedTest[] }> => patApi('GET', '/patient/me/tests');

export interface UiPatientInvoice {
  id: string;
  number: string;
  totalMinor: number;
  patientShareMinor: number;
  paidMinor: number;
  insurerShareMinor: number;
  status: string;
  currency: string;
  createdAt: string;
}

export interface UiPatientPayment {
  id: string;
  amountMinor: number;
  method: string | null;
  status: string;
  createdAt: string;
}

export interface UiPatientBilling {
  summary: { billedMinor: number; paidMinor: number; outstandingMinor: number; currency: string };
  invoices: UiPatientInvoice[];
  payments: UiPatientPayment[];
}

/** Patient billing transparency (API mode): own invoices + cleared vs owed. */
export const patientBilling = (): Promise<UiPatientBilling> => patApi('GET', '/patient/me/invoices');

export interface UiNetworkProfileFull {
  id: string;
  phone: string;
  firstName: string;
  lastName: string;
  fullName: string;
  dateOfBirth: string | null;
  sex: string;
  bloodGroup: string | null;
  address: string | null;
  city: string | null;
  country: string | null;
  emergencyContactName: string | null;
  emergencyContactPhone: string | null;
  chronicConditions: string[];
  allergies: string[];
  currentMedications: string[];
  verified: boolean;
  avatarUrl: string | null;
  insurers?: { clinicId: string; clinicName: string; insurerName: string; coveragePercent: number }[];
}

export async function patientUpdateProfile(patch: {
  firstName?: string;
  lastName?: string;
  dateOfBirth?: string | null;
  sex?: string;
  bloodGroup?: string | null;
  address?: string | null;
  city?: string | null;
  country?: string | null;
  emergencyContactName?: string | null;
  emergencyContactPhone?: string | null;
  chronicConditions?: string[];
  allergies?: string[];
  currentMedications?: string[];
}): Promise<UiNetworkProfileFull> {
  return patApi('PATCH', '/patient/me/profile', patch);
}

export async function patientProfile(): Promise<UiNetworkProfileFull> {
  return patApi('GET', '/patient/me/profile');
}

/** Available slots of one doctor, for booking straight from their card. */
export async function doctorSlots(
  slug: string,
  doctorId: string,
  days = 7,
): Promise<{ dateKey: string; slots: { startsAt: string; endsAt: string; localStart: string; localEnd: string }[] }[]> {
  const base = (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:4000';
  const response = await fetch(
    `${base}/public/${slug}/slots?days=${days}&doctorId=${encodeURIComponent(doctorId)}`,
  );
  if (!response.ok) throw new Error('Could not load availability.');
  return ((await response.json()) as { days: { dateKey: string; slots: { startsAt: string; endsAt: string; localStart: string; localEnd: string }[] }[] }).days;
}

export async function uploadAvatar(file: File): Promise<void> {
  const base64 = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (): void => {
      const result = String(reader.result ?? '');
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = (): void => reject(reader.error ?? new Error('Could not read the photo.'));
    reader.readAsDataURL(file);
  });
  await patApi('POST', '/patient/me/avatar', { mimeType: file.type, fileBase64: base64 });
}

const avatarCache = new Map<string, string>();

/** Authenticated avatar bytes as an object URL (img tags cannot send headers). */
export async function avatarObjectUrl(networkId: string, asPatient: boolean): Promise<string | null> {
  const cached = avatarCache.get(networkId);
  if (cached) return cached;
  const base = (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:4000';
  const token = asPatient ? getPatientToken() : getToken();
  if (!token) return null;
  const response = await fetch(`${base}/network/avatars/${networkId}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok) return null;
  const url = URL.createObjectURL(await response.blob());
  avatarCache.set(networkId, url);
  return url;
}

// ---------------------------------------------------------------------------
// Patient network: one identity per phone across clinics.
// ---------------------------------------------------------------------------

export interface UiNetworkProfile {
  id: string;
  fullName: string;
  phone: string;
  dateOfBirth: string | null;
  sex: string;
  verified: boolean;
}

export async function networkRegister(input: {
  phone: string;
  firstName: string;
  lastName: string;
  code: string;
  dateOfBirth?: string | null;
  sex?: string;
  bloodGroup?: string | null;
  address?: string | null;
  city?: string | null;
  chronicConditions?: string[];
  allergies?: string[];
  currentMedications?: string[];
}): Promise<{ id: string; phone: string; fullName: string }> {
  const base = (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:4000';
  const response = await fetch(`${base}/network/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    let message = 'Registration failed.';
    try {
      const parsed = (await response.json()) as { error?: { message?: string } };
      if (parsed.error?.message) message = parsed.error.message;
    } catch {
      // Keep the generic message.
    }
    throw new Error(message);
  }
  return (await response.json()) as { id: string; phone: string; fullName: string };
}

export async function networkPatientLogin(phone: string, code: string): Promise<void> {
  const base = (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:4000';
  const response = await fetch(`${base}/auth/network`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ phone, code }),
  });
  if (!response.ok) throw new Error('Incorrect phone number or code.');
  const data = (await response.json()) as { token: string };
  localStorage.setItem(PATIENT_TOKEN_KEY, data.token);
}

export async function networkLookup(phone: string): Promise<{
  registered: boolean;
  profile?: UiNetworkProfile;
  linkedLocalPatientId?: string | null;
}> {
  return api('GET', `/network/lookup?phone=${encodeURIComponent(phone)}`);
}

export async function networkImport(networkPatientId: string): Promise<{ localPatientId: string }> {
  return api('POST', '/network/import', { networkPatientId });
}

export interface UiSharedRecord {
  profile: UiNetworkProfile;
  clinics: {
    clinicId: string;
    clinicName: string;
    vitals: { kind: string; value: number; unit: string; measuredAt: string }[];
    prescriptions: { id: string; items: { drug: string; dose?: string | null; frequency?: string | null }[]; status: string; createdAt: string }[];
    visits: { id: string; visitType: string; diagnosis: string | null; createdAt: string }[];
    requestedTests: { id: string; name: string; status: string; createdAt: string }[];
    documents: { id: string; title: string | null; fileName: string; kind: string; createdAt: string }[];
    appointments: { id: string; startsAt: string; status: string }[];
    reminders: { id: string; scheduledFor: string; template: string; appointmentStartsAt: string | null }[];
  }[];
}

export async function sharedRecord(networkId: string): Promise<UiSharedRecord> {
  return api('GET', `/network/patients/${networkId}/record`);
}

export async function networkIdForLocal(localId: string): Promise<string | null> {
  try {
    const data = await api<{ networkPatientId: string }>('GET', `/network/by-local/${localId}`);
    return data.networkPatientId;
  } catch {
    return null;
  }
}

export interface UiDirectory {
  clinics: { id: string; name: string; country: string | null; phone: string | null; slug: string }[];
  doctors: { id: string; clinicId: string; name: string; specialty: string | null; clinicName: string; clinicPhone: string | null; clinicInsurers: string[] }[];
}

export async function directory(): Promise<UiDirectory> {
  const base = (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:4000';
  const response = await fetch(`${base}/directory`);
  if (!response.ok) throw new Error('Directory unavailable.');
  return (await response.json()) as UiDirectory;
}

export async function patientRecord(): Promise<UiSharedRecord> {
  return patApi('GET', '/patient/me/record');
}

export async function patientBookCross(clinicId: string, startsAt: string, reason?: string | null): Promise<unknown> {
  return patApi('POST', '/patient/me/appointments', {
    clinicId,
    startsAt,
    ...(reason ? { reason } : {}),
  });
}

// ---------------------------------------------------------------------------
// Practice learning: the doctor's own habits for a diagnosis.
// ---------------------------------------------------------------------------

export interface UiPracticePattern {
  drug: string;
  times: number;
  dose: string | null;
  frequency: string | null;
  lastUsed: string;
  basis: string | null;
}

export interface UiCurrentLabs {
  hba1c?: number | null;
  creatinine?: number | null;
  egfr?: number | null;
  ldl?: number | null;
  systolic?: number | null;
}

/**
 * What this doctor usually prescribes for this diagnosis, learned from their
 * own history. Prescriptions join to visits for the diagnosis text; the
 * shared learner ranks by the doctor's frequency, never a global default.
 */
export async function practicePatterns(
  diagnosis: string,
  currentLabs?: UiCurrentLabs,
  limit = 5,
): Promise<UiPracticePattern[]> {
  if (!diagnosis.trim()) return [];
  if (await useFirestore()) {
    const s = await store();
    const [prescriptions, visits] = await Promise.all([s.listAllPrescriptions(), s.listAllVisits()]);
    const diagnosisByVisit = new Map(visits.map((v) => [v.id, v.diagnosis]));
    const { learnPrescribingPatterns } = await import('@mediflow/shared');
    return learnPrescribingPatterns(
      prescriptions.map((p) => ({
        diagnosis: p.visitId ? (diagnosisByVisit.get(p.visitId) ?? null) : null,
        items: p.items,
        ...(p.labs ? { labs: p.labs } : {}),
        createdAt: p.createdAt,
      })),
      diagnosis,
      currentLabs,
      limit,
    );
  }
  const [prescriptions, visits] = await Promise.all([
    api<{ items?: { visitId?: string | null; items?: { drug?: string; dose?: string | null; frequency?: string | null }[]; labs?: Record<string, number>; createdAt?: string }[] }>(
      'GET',
      '/prescriptions?limit=200',
    ),
    api<{ items?: { id: string; diagnosis?: string | null }[] }>('GET', '/visits?limit=200'),
  ]);
  const diagnosisByVisit = new Map((visits.items ?? []).map((v) => [v.id, v.diagnosis ?? null]));
  const { learnPrescribingPatterns } = await import('@mediflow/shared');
  return learnPrescribingPatterns(
    (prescriptions.items ?? []).map((p) => ({
      diagnosis: p.visitId ? (diagnosisByVisit.get(p.visitId) ?? null) : null,
      items: (p.items ?? []).map((i) => ({ drug: i.drug ?? '', dose: i.dose ?? null, frequency: i.frequency ?? null })),
      labs: p.labs ?? {},
      createdAt: p.createdAt ?? '',
    })),
    diagnosis,
    currentLabs,
    limit,
  );
}

export async function vitalsAll(patientId: string): Promise<{ kind: string; value: number; unit: string; measuredAt: string }[]> {
  if (await useFirestore()) {
    return (await store()).latestVitals(patientId, 200);
  }
  const data = await api<{ items?: { kind?: string; value?: number; unit?: string; measured_at?: string; measuredAt?: string }[] }>(
    'GET',
    `/vitals?patientId=${encodeURIComponent(patientId)}&limit=200`,
  );
  return (data.items ?? []).map((v) => ({
    kind: v.kind ?? '',
    value: v.value ?? 0,
    unit: v.unit ?? '',
    measuredAt: v.measuredAt ?? v.measured_at ?? '',
  }));
}

// ---------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------

export interface UiAppointment {
  id: string;
  /** Null for walk-ins and for rows the legacy API does not join. */
  patientId: string | null;
  startsAt: string;
  patientName: string;
  status: string;
}

export async function apptsRange(from: string, to: string): Promise<UiAppointment[]> {
  if (await useFirestore()) {
    return (await store()).listAppointments(from, to);
  }
  const data = await api<{ items?: UiAppointment[] }>('GET', `/appointments?from=${from}&to=${to}&limit=200`);
  return data.items ?? [];
}

/**
 * Today's appointments, narrowed to one patient, for the QR check-in flow.
 *
 * `apptsRange` already returns the day, so this filters client-side rather than
 * adding a second query path: one shape to keep correct across both backends.
 */
export async function apptTodayForPatient(patientId: string): Promise<UiAppointment | null> {
  const today = new Date().toISOString().slice(0, 10);
  const rows = await apptsRange(today, today);
  const mine = rows.filter((a) => a.patientId === patientId);
  // A patient can hold two slots; the earliest one is the visit being checked in.
  return mine.sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt))[0] ?? null;
}

export async function apptBook(input: {
  patientId?: string | null;
  patientName: string;
  patientPhone: string;
  startsAt: string;
}): Promise<void> {
  if (await useFirestore()) {
    await (await store()).bookAppointment(input);
    return;
  }
  await api('POST', '/appointments', { ...input, source: 'staff' });
}

/** Staff day view: booked times (who holds what) + free starts. */
export async function fbDaySchedule(
  dateKey: string,
): Promise<{
  closed: boolean;
  busy: { startsAt: string; endsAt: string; patientName: string; kind: string }[];
  free: { startsAt: string; endsAt: string; localStart: string }[];
}> {
  return (await store()).daySchedule(dateKey);
}

export interface UiFollowUp {
  id: string;
  patientId: string;
  /** The recall line as staff wrote it, e.g. "Bloods after 3 months". */
  name: string;
  status: string;
  nextDueAt: string | null;
  intervalDays: number;
}

/** Active follow-ups for the recall radar, earliest due first. */
export async function followUpsDue(): Promise<UiFollowUp[]> {
  if (await useFirestore()) {
    return (await store()).listFollowUps().then((rows) =>
      rows
        .filter((r) => r.patientId !== null)
        .map((r) => ({
          id: r.id,
          patientId: r.patientId as string,
          name: r.reason ?? r.patientName,
          status: r.status,
          nextDueAt: r.nextDueAt,
          intervalDays: 0,
        }))
        .sort((a, b) => (a.nextDueAt ?? '').localeCompare(b.nextDueAt ?? '')),
    );
  }
  const data = await api<{ items?: { id: string; patientId: string; name: string; status: string; nextDueAt: string; intervalDays: number }[] }>(
    'GET',
    '/follow-ups?status=active&limit=200',
  );
  return (data.items ?? [])
    .map((f) => ({
      id: f.id,
      patientId: f.patientId,
      name: f.name,
      status: f.status,
      nextDueAt: f.nextDueAt ?? null,
      intervalDays: f.intervalDays ?? 0,
    }))
    .sort((a, b) => (a.nextDueAt ?? '').localeCompare(b.nextDueAt ?? ''));
}

/**
 * Queue one recall message.
 *
 * The opt-in check lives in the store for Firestore; on the API path the server
 * re-checks it when it writes the outbox row, so a stale opt-in cannot slip a
 * message through either way.
 */
export async function recallEnqueue(
  patientId: string,
  body: string,
  followUpId: string | null,
): Promise<{ queued: boolean; reason: 'no-phone' | 'opted-out' | 'ok' }> {
  if (await useFirestore()) {
    return (await store()).enqueueRecall(patientId, body, followUpId);
  }
  const res = await api<{ queued?: boolean; reason?: 'no-phone' | 'opted-out' | 'ok' }>(
    'POST',
    '/outbox/recall',
    { patientId, body, ...(followUpId ? { followUpId } : {}) },
  );
  return { queued: res.queued !== false, reason: res.reason ?? 'ok' };
}

export async function apptTransition(id: string, action: 'in' | 'done' | 'cancel'): Promise<void> {
  if (await useFirestore()) {
    const s = await store();
    await s.setAppointmentStatus(id, action === 'in' ? 'checked_in' : action === 'done' ? 'completed' : 'cancelled');
    return;
  }
  const path =
    action === 'in'
      ? `/appointments/${id}/checked-in`
      : action === 'done'
        ? `/appointments/${id}/complete`
        : `/appointments/${id}/cancel`;
  await api('POST', path, action === 'cancel' ? {} : undefined);
}

export interface UiSlot {
  startsAt: string;
  endsAt: string;
  dateKey: string;
  localStart: string;
  localEnd: string;
  durationMinutes: number;
}

export interface UiSlotDay {
  dateKey: string;
  count: number;
  slots: UiSlot[];
  note: string | null;
}

/** Free slots only - the server computes availability, the UI never guesses. */
export async function scheduleAvailability(from: string, to: string): Promise<UiSlotDay[]> {
  if (await useFirestore()) {
    throw new Error('Availability lookup needs the API backend.');
  }
  const data = await api<{ days?: UiSlotDay[] }>(
    'GET',
    `/schedule/availability?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
  );
  return data.days ?? [];
}

export type InitiatedBy = 'clinic' | 'patient';

/**
 * Postpone with a reason. The server revalidates the slot, rebuilds reminders,
 * and queues an Arabic WhatsApp task (with apology when clinic-side).
 */
export async function apptReschedule(
  id: string,
  input: { startsAt: string; reason: string; initiatedBy: InitiatedBy },
): Promise<{ whatsappQueued: boolean }> {
  if (await useFirestore()) {
    const s = await store();
    await s.rescheduleAppointment(id, input.startsAt);
    return { whatsappQueued: false };
  }
  const data = await api<{ whatsappQueued?: boolean }>('POST', `/appointments/${id}/reschedule`, input);
  return { whatsappQueued: data.whatsappQueued ?? false };
}

/** Cancel with a reason - also queues the Arabic WhatsApp task (API mode). */
export async function apptCancel(id: string, input: { reason?: string | null; initiatedBy?: InitiatedBy } = {}): Promise<{
  whatsappQueued: boolean;
}> {
  if (await useFirestore()) {
    await (await store()).setAppointmentStatus(id, 'cancelled');
    return { whatsappQueued: false };
  }
  const data = await api<{ whatsappQueued?: boolean }>('POST', `/appointments/${id}/cancel`, {
    reason: input.reason ?? null,
    initiatedBy: input.initiatedBy ?? 'clinic',
  });
  return { whatsappQueued: data.whatsappQueued ?? false };
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

export interface UiToday {
  appointments: { id: string; startsAt: string; patientName: string; status: string }[];
  alerts: { items: { severity: string; title: string }[] };
  followUps: { due: number; active: number };
}

export async function dashToday(): Promise<UiToday> {
  if (await useFirestore()) {
    const s = await store();
    const today = new Date();
    const key = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const summary = await s.todaySummary(key);
    return {
      appointments: summary.appointments.map((a) => ({
        id: a.id,
        startsAt: a.startsAt,
        patientName: a.patientName,
        status: a.status,
      })),
      alerts: { items: summary.alerts.map((a) => ({ severity: a.severity, title: a.title })) },
      followUps: summary.followUps,
    };
  }
  const data = await api<{
    appointments?: { next?: { id: string; startsAt: string; patientName?: string; status?: string }[] };
    alerts?: { items?: { severity?: string; title?: string }[] };
    followUps?: { due?: number; active?: number };
  }>('GET', '/dashboard/today');
  // The API returns appointments as { total, byStatus, next }: the dashboard
  // shows the upcoming list, which is `next`.
  const upcoming = data.appointments?.next ?? [];
  return {
    appointments: upcoming.map((a) => ({
      id: a.id,
      startsAt: a.startsAt,
      patientName: a.patientName ?? a.id,
      status: a.status ?? '',
    })),
    alerts: {
      items: (data.alerts?.items ?? []).map((a) => ({ severity: a.severity ?? '', title: a.title ?? '' })),
    },
    followUps: { due: data.followUps?.due ?? 0, active: data.followUps?.active ?? 0 },
  };
}

export async function notesList(): Promise<{ title: string; body: string }[]> {
  if (await useFirestore()) return [];
  const data = await api<{ items?: { title?: string; body?: string }[] }>('GET', '/notifications?limit=20');
  return (data.items ?? []).map((n) => ({ title: n.title ?? '', body: n.body ?? '' }));
}

export async function notesReadAll(): Promise<void> {
  if (await useFirestore()) return;
  await api('POST', '/notifications/read-all');
}

export async function pendingSyncCount(): Promise<number> {
  if (await useFirestore()) return 0;
  return readQueue().length;
}

// ---------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------

export interface UiDocument {
  id: string;
  patientId: string;
  fileName: string;
  title: string | null;
  kind: string;
  mimeType: string;
  status: string;
  hasFile: boolean;
  createdAt: string;
}

interface ApiDocRow {
  id: string;
  patient_id?: string;
  file_name?: string;
  title?: string | null;
  kind?: string;
  mime_type?: string;
  status?: string;
  storage_path?: string | null;
  created_at?: string;
}

function toUiDocumentFb(d: {
  id: string;
  patientId: string;
  fileName: string;
  title: string | null;
  kind: string;
  mimeType: string;
  status: string;
  downloadUrl: string | null;
  createdAt: string;
}): UiDocument {
  return { ...d, hasFile: d.downloadUrl !== null || d.status === 'stored' || d.status === 'processed' };
}

export async function docsList(): Promise<UiDocument[]> {
  if (await useFirestore()) {
    return (await (await store()).listDocuments()).map(toUiDocumentFb);
  }
  const data = await api<{ items?: ApiDocRow[] }>('GET', '/documents?limit=50');
  return (data.items ?? []).map((d) => ({
    id: d.id,
    patientId: d.patient_id ?? '',
    fileName: d.file_name ?? d.id,
    title: d.title ?? null,
    kind: d.kind ?? '',
    mimeType: d.mime_type ?? '',
    status: d.status ?? '',
    hasFile: d.storage_path != null,
    createdAt: d.created_at ?? '',
  }));
}

export async function docsForPatient(patientId: string): Promise<UiDocument[]> {
  if (await useFirestore()) {
    return (await (await store()).documentsForPatient(patientId)).map(toUiDocumentFb);
  }
  const data = await api<{ items?: ApiDocRow[] }>(
    'GET',
    `/documents?patientId=${encodeURIComponent(patientId)}&limit=50`,
  );
  return (data.items ?? []).map((d) => ({
    id: d.id,
    patientId: d.patient_id ?? patientId,
    fileName: d.file_name ?? d.id,
    title: d.title ?? null,
    kind: d.kind ?? '',
    mimeType: d.mime_type ?? '',
    status: d.status ?? '',
    hasFile: d.storage_path != null,
    createdAt: d.created_at ?? '',
  }));
}

export async function docRecord(
  meta: {
    patientId: string;
    kind: string;
    title?: string | null;
    fileName: string;
    mimeType: string;
    byteSize: number;
    checksum: string;
  },
  file?: { base64: string; blob: Blob },
): Promise<void> {
  if (await useFirestore()) {
    const s = await store();
    const id = await s.recordDocument(meta);
    if (file) {
      await s.uploadDocumentBytes(id, meta.fileName, file.blob);
    }
    return;
  }
  if (file) {
    await api('POST', '/documents/upload', { ...meta, fileBase64: file.base64 });
    return;
  }
  await api('POST', '/documents', meta);
}
/** Raw bytes of a stored file, for re-reading or processing. */
export async function docBlob(id: string): Promise<Blob> {
  if (await useFirestore()) {
    const s = await store();
    const docs = await s.listDocuments();
    const found = docs.find((d) => d.id === id);
    if (!found?.downloadUrl) throw new Error('No file stored for this document.');
    const response = await fetch(found.downloadUrl);
    if (!response.ok) throw new Error('Could not download the stored file.');
    return response.blob();
  }
  const token = getToken();
  if (!token) throw new Error('Not signed in.');
  const base = (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:4000';
  const response = await fetch(`${base}/documents/${id}/file`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error('No file stored for this document.');
  return response.blob();
}

/** A viewable/downloadable URL for the stored bytes (object URL in API mode). */
export async function docFileUrl(id: string): Promise<string> {
  if (await useFirestore()) {
    const s = await store();
    const docs = await s.listDocuments();
    const found = docs.find((d) => d.id === id);
    if (found?.downloadUrl) return found.downloadUrl;
    throw new Error('No file stored for this document.');
  }
  return URL.createObjectURL(await docBlob(id));
}

export async function docOcr(id: string, text: string): Promise<void> {
  if (await useFirestore()) {
    await (await store()).attachOcr(id, text);
    return;
  }
  await api('POST', `/documents/${id}/ocr`, { text });
}

export async function docDelete(id: string): Promise<void> {
  if (await useFirestore()) {
    await (await store()).deleteDocument(id);
    return;
  }
  await api('DELETE', `/documents/${id}`);
}

// ---------------------------------------------------------------------------
// Finance
// ---------------------------------------------------------------------------

export interface UiInvoice {
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

export interface UiPayment {
  id: string;
  invoiceId: string | null;
  amountMinor: number;
  method: string;
  createdAt: string;
}

export async function paymentsList(patientId?: string, invoiceId?: string, from?: string, to?: string): Promise<UiPayment[]> {
  if (await useFirestore()) {
    const all = await (await store()).listPayments(patientId, invoiceId);
    return all.filter(
      (p) => (!from || p.createdAt.slice(0, 10) >= from) && (!to || p.createdAt.slice(0, 10) <= to),
    );
  }
  const params = new URLSearchParams({ limit: '100' });
  if (patientId) params.set('patientId', patientId);
  if (invoiceId) params.set('invoiceId', invoiceId);
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  const data = await api<{ items?: { id: string; invoice_id?: string | null; amount_minor?: number; method?: string; created_at?: string }[] }>(
    'GET',
    `/payments?${params.toString()}`,
  );
  return (data.items ?? []).map((p) => ({
    id: p.id,
    invoiceId: p.invoice_id ?? null,
    amountMinor: p.amount_minor ?? 0,
    method: p.method ?? '',
    createdAt: p.created_at ?? '',
  }));
}

export interface UiInsurer {
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
}

export async function insurersList(): Promise<UiInsurer[]> {
  if (await useFirestore()) {
    return (await store()).listInsurers();
  }
  const data = await api<{ items?: UiInsurer[] }>('GET', '/insurers?limit=100');
  return data.items ?? [];
}

export async function insurerCreate(input: {
  name: string;
  nameAr?: string | null;
  coveragePercent: number;
  annualLimitMinor?: number | null;
  perVisitLimitMinor?: number | null;
  phone?: string | null;
  email?: string | null;
  notes?: string | null;
}): Promise<void> {
  if (await useFirestore()) {
    await (await store()).createInsurer(input);
    return;
  }
  await api('POST', '/insurers', input);
}

export async function insurerUpdate(id: string, input: Partial<UiInsurer>): Promise<void> {
  if (await useFirestore()) {
    await (await store()).updateInsurer(id, input);
    return;
  }
  await api('PATCH', `/insurers/${id}`, input);
}

export interface UiInsurerStatement {
  insurer: UiInsurer;
  billedMinor: number;
  collectedMinor: number;
  outstandingMinor: number;
  invoices: { id: string; patientId: string; patientName: string; policyNo: string | null; totalMinor: number; insurerShareMinor: number; status: string; createdAt: string }[];
  receipts: { id: string; amountMinor: number; reference: string | null; note: string | null; receivedAt: string }[];
}

export async function insurerStatement(id: string): Promise<UiInsurerStatement> {
  if (await useFirestore()) {
    return (await store()).insurerStatement(id);
  }
  return api<UiInsurerStatement>('GET', `/insurers/${id}/statement`);
}

export async function insurerCollect(insurerId: string, amountMinor: number, reference?: string | null): Promise<void> {
  if (await useFirestore()) {
    await (await store()).recordInsurerPayment(insurerId, amountMinor, reference ?? null);
    return;
  }
  await api('POST', '/insurer-payments', {
    insurerId,
    amountMinor,
    ...(reference ? { reference } : {}),
  });
}

export async function finSummary(from?: string, to?: string): Promise<{ outstandingMinor: number; collectedMinor: number; currency: string }> {
  if (await useFirestore()) {
    return (await store()).financeSummary();
  }
  const params = new URLSearchParams();
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  const suffix = params.toString() ? `?${params.toString()}` : '';
  return api<{ outstandingMinor: number; collectedMinor: number; currency: string }>('GET', `/finance/summary${suffix}`);
}
export async function invList(from?: string, to?: string): Promise<UiInvoice[]> {
  if (await useFirestore()) {
    const all = await (await store()).listInvoices();
    return all.filter(
      (i) => (!from || i.createdAt.slice(0, 10) >= from) && (!to || i.createdAt.slice(0, 10) <= to),
    );
  }
  const params = new URLSearchParams({ limit: '50' });
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  const data = await api<{ items?: { id: string; patient_id?: string; status?: string; total_minor?: number; paid_minor?: number; insurer_id?: string | null; insurer_share_minor?: number; patient_share_minor?: number; currency?: string; created_at?: string }[] }>(
    'GET',
    `/invoices?${params.toString()}`,
  );
  return (data.items ?? []).map((i) => ({
    id: i.id,
    patientId: i.patient_id ?? '',
    status: i.status ?? '',
    totalMinor: i.total_minor ?? 0,
    paidMinor: i.paid_minor ?? 0,
    insurerId: i.insurer_id ?? null,
    insurerShareMinor: i.insurer_share_minor ?? 0,
    patientShareMinor: i.patient_share_minor ?? i.total_minor ?? 0,
    currency: i.currency ?? '',
    createdAt: i.created_at ?? '',
  }));
}

export async function invoicesForPatient(patientId: string): Promise<UiInvoice[]> {
  if (await useFirestore()) {
    return (await store()).invoicesForPatient(patientId);
  }
  const data = await api<{ items?: { id: string; patient_id?: string; status?: string; total_minor?: number; paid_minor?: number; insurer_id?: string | null; insurer_share_minor?: number; patient_share_minor?: number; currency?: string; created_at?: string }[] }>(
    'GET',
    `/invoices?patientId=${encodeURIComponent(patientId)}&limit=50`,
  );
  return (data.items ?? []).map((i) => ({
    id: i.id,
    patientId: i.patient_id ?? patientId,
    status: i.status ?? '',
    totalMinor: i.total_minor ?? 0,
    paidMinor: i.paid_minor ?? 0,
    insurerId: i.insurer_id ?? null,
    insurerShareMinor: i.insurer_share_minor ?? 0,
    patientShareMinor: i.patient_share_minor ?? i.total_minor ?? 0,
    currency: i.currency ?? '',
    createdAt: i.created_at ?? '',
  }));
}

export async function invCreate(patientId: string, totalMinor: number, taxPercent?: number): Promise<void> {
  if (await useFirestore()) {
    await (await store()).createInvoice(patientId, totalMinor);
    return;
  }
  await api('POST', '/invoices', {
    patientId,
    items: [{ description: 'consultation', unitPriceMinor: totalMinor, quantity: 1 }],
    ...(taxPercent !== undefined ? { taxPercent } : {}),
  });
}

export async function payRecord(
  patientId: string,
  invoiceId: string | null,
  amountMinor: number,
  method: string,
): Promise<void> {
  if (await useFirestore()) {
    await (await store()).recordPayment(patientId, invoiceId, amountMinor, method);
    return;
  }
  await api('POST', '/payments', {
    patientId,
    ...(invoiceId ? { invoiceId } : {}),
    amountMinor,
    method,
  });
}

// ---------------------------------------------------------------------------
// WhatsApp
// ---------------------------------------------------------------------------

export interface UiThread {
  id: string;
  lastMessageAt: string | null;
  unreadCount: number;
}

export interface UiMessage {
  id: string;
  direction: string;
  body: string;
  status: string;
  createdAt: string;
}

export async function threadsList(): Promise<UiThread[]> {
  if (await useFirestore()) {
    return (await store()).listThreads();
  }
  const data = await api<{ items?: { id: string; lastMessageAt?: string; unreadCount?: number }[] }>(
    'GET',
    '/threads?limit=50',
  );
  return (data.items ?? []).map((t) => ({ id: t.id, lastMessageAt: t.lastMessageAt ?? null, unreadCount: t.unreadCount ?? 0 }));
}

export async function threadMessages(threadId: string): Promise<UiMessage[]> {
  if (await useFirestore()) {
    return (await store()).threadMessages(threadId);
  }
  const data = await api<{ items?: UiMessage[] }>('GET', `/threads/${threadId}/messages`);
  return data.items ?? [];
}

export async function threadRead(threadId: string): Promise<void> {
  if (await useFirestore()) {
    await (await store()).markThreadRead(threadId);
    return;
  }
  await api('POST', `/threads/${threadId}/read`, {}).catch(() => undefined);
}

export async function msgSend(patientId: string, body: string): Promise<void> {
  if (await useFirestore()) {
    await (await store()).sendPatientMessage(patientId, body);
    return;
  }
  await api('POST', '/messages', { patientId, body });
}

export interface UiOutboxRow {
  id: string;
  to: string;
  body: string;
  template: string;
  status: string;
  manualSentAt: string | null;
}

export async function outboxList(): Promise<UiOutboxRow[]> {
  if (await useFirestore()) {
    return (await store()).listOutbox();
  }
  const data = await api<{ items?: { id?: string; to?: string; body?: string; template?: string; status?: string }[] }>(
    'GET',
    '/outbox?limit=50',
  );
  return (data.items ?? []).map((o) => ({
    id: o.id ?? '',
    to: o.to ?? '',
    body: o.body ?? '',
    template: o.template ?? '',
    status: o.status ?? '',
    manualSentAt: null,
  }));
}

/** Rows still needing a human press of send (both backends, one shape). */
/**
 * WhatsApp device linking (Baileys gateway).
 *
 * The clinic id is never sent from here: the API derives it from the signed
 * session, so there is no argument for a caller to get wrong and nothing in the
 * browser to tamper with. The gateway's admin token stays on the server, so
 * this is an ordinary authenticated call like any other.
 *
 * Both calls bypass the GET cache and refuse offline queueing. A cached QR is
 * useless (it expires in about half a minute) and a queued pairing-code request
 * would report success while doing nothing, which is the worst possible answer
 * to "link my phone now".
 */
export interface UiDeviceLink {
  clinicId: string;
  state: string;
  registered: boolean;
  paired: boolean;
  qr: string | null;
  qrUpdatedAt: string | null;
  pairingCode: string | null;
  connectedAt: string | null;
  lastError: string | null;
  updatedAt: string | null;
}

export async function whatsappDevice(): Promise<UiDeviceLink> {
  return api<UiDeviceLink>('GET', '/whatsapp/device', undefined, { noCache: true });
}

export async function whatsappPairingCode(): Promise<string> {
  const data = await api<{ pairingCode: string }>(
    'POST',
    '/whatsapp/device/pairing-code',
    {},
    { noCache: true, queueable: false },
  );
  return data.pairingCode;
}

export async function outboxPending(): Promise<UiOutboxRow[]> {
  const items = await outboxList();
  return items.filter((o) => {
    if (o.manualSentAt) return false;
    return o.status === 'queued' || o.status === 'pending' || o.status === 'processing' || o.status === 'failed';
  });
}

/**
 * Record a manual click-to-send: the doctor pressed send inside the WhatsApp
 * app. API mode flips the row to sent server-side; Firestore mode stamps
 * `manualSentAt` (clients may not change status) for the gateway sweep.
 */
export async function outboxManualSend(id: string): Promise<void> {
  if (await useFirestore()) {
    await (await store()).manualSendOutbox(id);
    return;
  }
  await api('POST', `/outbox/${id}/manual-send`, {});
}

/** wa.me click-to-chat link: opens the chat with the text prefilled. */
export function waLink(phone: string, body: string): string {
  const digits = phone.replace(/[^0-9]/g, '');
  return `https://wa.me/${digits}?text=${encodeURIComponent(body)}`;
}

// ---------------------------------------------------------------------------
// Decision support
// ---------------------------------------------------------------------------

export interface UiReview {
  severity: string;
  warnings: string[];
  suggestions: string[];
  regimen: UiPrescriptionItem[];
  labs: { kind: string; value: number; unit: string; measuredAt: string }[];
  labGuided: { drug: string; dose: string; frequency: string; reasons: string[]; contraindicated: boolean }[];
  lifestyle: { targets: string[]; diet: string[]; exercise: string[] };
  raw: unknown;
}

interface RawReview {
  interactions?: { severity?: string; drugA?: string; drugB?: string; clinicalEffect?: string }[];
  allergyConflicts?: { severity?: string; drugName?: string; allergen?: string; advice?: string }[];
  contraindicationNotes?: string[];
  dosingAdjustments?: { severity?: string; drugName?: string; note?: string }[];
  redFlags?: string[];
  monitoring?: { label?: string; frequency?: string; reason?: string }[];
  requiredInvestigations?: string[];
  suggestedRegimen?: {
    genericName?: string;
    dose?: string;
    frequency?: string;
    durationDays?: number | null;
    indication?: string;
  }[];
}

function shapeRawReview(result: RawReview): UiReview {
  const warnings: string[] = [];
  for (const a of result.allergyConflicts ?? []) {
    warnings.push(`Allergy ${a.severity ?? ''}: ${a.drugName ?? ''} × ${a.allergen ?? ''} — ${a.advice ?? ''}`);
  }
  for (const n of result.contraindicationNotes ?? []) warnings.push(n);
  for (const i of result.interactions ?? []) {
    if (i.severity === 'contraindicated' || i.severity === 'major') {
      warnings.push(`Interaction ${i.severity}: ${i.drugA ?? ''} × ${i.drugB ?? ''} — ${i.clinicalEffect ?? ''}`);
    }
  }
  for (const d of result.dosingAdjustments ?? []) {
    if (d.severity === 'critical') warnings.push(`Dose ${d.severity}: ${d.drugName ?? ''} — ${d.note ?? ''}`);
  }
  for (const r of result.redFlags ?? []) warnings.push(`Red flag: ${r}`);

  const suggestions: string[] = [];
  for (const m of result.monitoring ?? []) {
    suggestions.push(`Monitor ${m.label ?? ''} (${m.frequency ?? ''}): ${m.reason ?? ''}`);
  }
  for (const inv of result.requiredInvestigations ?? []) suggestions.push(`Investigate: ${inv}`);

  return {
    severity: warnings.length > 0 ? 'warning' : 'info',
    warnings,
    suggestions,
    regimen: (result.suggestedRegimen ?? []).map((s) => ({
      drug: s.genericName ?? '',
      dose: s.dose || null,
      frequency: s.frequency || null,
      durationDays: s.durationDays ?? null,
      instructions: s.indication || null,
    })),
    labGuided: [],
    labs: [],
    lifestyle: { targets: [], diet: [], exercise: [] },
    raw: result,
  };
}

export async function reviewRun(patientId: string, diagnosis: string, medications: string[]): Promise<UiReview> {
  if (await useFirestore()) {
    return (await store()).runReview(patientId, diagnosis, medications);
  }
  const data = await api<{
    result?: RawReview;
    labsUsed?: { kind?: string; value?: number; unit?: string; measuredAt?: string }[];
    labGuided?: { drug?: string; dose?: string; frequency?: string; reasons?: string[]; contraindicated?: boolean }[];
    lifestyle?: { targets?: string[]; diet?: string[]; exercise?: string[] };
  }>('POST', `/records/${patientId}/decision-support`, {
    diagnosis,
    ...(medications.length > 0 ? { medications } : {}),
  });
  const shaped = shapeRawReview(data.result ?? {});
  const strArr = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  return {
    ...shaped,
    labs: (data.labsUsed ?? []).map((l) => ({
      kind: l.kind ?? '',
      value: l.value ?? 0,
      unit: l.unit ?? '',
      measuredAt: l.measuredAt ?? '',
    })),
    labGuided: (data.labGuided ?? []).map((g) => ({
      drug: g.drug ?? '',
      dose: g.dose ?? '',
      frequency: g.frequency ?? '',
      reasons: Array.isArray(g.reasons) ? g.reasons.filter((x): x is string => typeof x === 'string') : [],
      contraindicated: g.contraindicated === true,
    })),
    lifestyle: {
      targets: strArr(data.lifestyle?.targets),
      diet: strArr(data.lifestyle?.diet),
      exercise: strArr(data.lifestyle?.exercise),
    },
  };
}

export interface UiInteraction {
  drug: string;
  interactingDrug: string;
  severity: string;
  message: string;
}

export async function interactionsCheck(patientId: string, medications: string): Promise<UiInteraction[]> {
  if (await useFirestore()) {
    return (await store()).checkInteractions(medications);
  }
  const data = await api<{ items?: UiInteraction[] }>(
    'GET',
    `/records/${patientId}/interactions?medications=${encodeURIComponent(medications)}`,
  );
  return data.items ?? [];
}

export { OfflineQueuedError };
