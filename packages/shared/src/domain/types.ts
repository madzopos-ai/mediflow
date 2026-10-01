/**
 * Shared TypeScript entity contracts.
 * These types mirror the database schema and are shared by the API and the PWA
 * (including the offline Dexie mirror), so they must stay serialisable.
 */

import type {
  AlertKind,
  AlertSeverity,
  AlertStatus,
  BloodGroup,
  Capability,
  Channel,
  DepositMethod,
  DocumentKind,
  FollowUpStatus,
  FollowUpTrigger,
  Language,
  MemberRole,
  MemberStatus,
  MessageDirection,
  MessageStatus,
  OutboxStatus,
  PaymentMethod,
  PaymentStatus,
  ReminderChannel,
  ReminderStatus,
  ReminderTemplate,
  Sex,
  Source,
  Specialty,
  TransactionType,
  AppointmentStatus,
  VitalKind,
} from './enums.js';

/** Every persisted row carries these. */
export interface BaseEntity {
  id: string;
  clinicId: string;
  createdAt: string;
  updatedAt: string;
}

export interface User extends BaseEntity {
  email: string;
  passwordHash: string;
  fullName: string;
  phone: string | null;
  locale: Language;
  isPlatformAdmin: boolean;
  lastLoginAt: string | null;
  disabledAt: string | null;
}

export interface Clinic extends BaseEntity {
  name: string;
  slug: string;
  /** Public booking-link slug; null disables online booking. */
  bookingSlug: string | null;
  bookingEnabled: boolean;
  specialty: Specialty;
  timezone: string;
  currency: string;
  locale: Language;
  intakeSide: 'ltr' | 'rtl';
  phone: string | null;
  email: string | null;
  address: string | null;
  city: string | null;
  country: string | null;
  logoUrl: string | null;
  licenseNumber: string | null;
  /** Retained patients are eligible for automated marketing-ish messages. */
  consentMarketing: boolean;
  active: boolean;
  plan: string;
  settings: ClinicSettings;
}

export interface ClinicSettings {
  /** Global feature toggles. */
  features: FeatureToggles;
  reminders: ReminderPolicy;
  followUps: FollowUpPolicy;
  booking: BookingPolicy;
  whatsapp: WhatsAppPolicy;
  ai: AiPolicy;
  finance: FinancePolicy;
  notifications: NotificationPolicy;
}

export interface FeatureToggles {
  /** Require a deposit before a booking is confirmed. */
  requireDepositOnBooking: boolean;
  defaultDepositAmountMinor: number;
  defaultDepositMethod: DepositMethod;
  /** Allow cash patients to skip online deposit. */
  allowCashInsteadOfDeposit: boolean;
  automatedWhatsappReminders: boolean;
  automatedMedicationNotifications: boolean;
  automatedChronicFollowUps: boolean;
  criticalValueAlerts: boolean;
  publicBookingLink: boolean;
  ePrescriptions: boolean;
  aiDecisionSupport: boolean;
  aiVoiceSummaries: boolean;
  requireDepositToConfirmAppointment: boolean;
}

export interface ReminderPolicy {
  enabled: boolean;
  /** Offsets in minutes before the appointment start. */
  defaultOffsetsMinutes: number[];
  channels: ReminderChannel[];
  template: ReminderTemplate;
  /** Extra offsets only for chronic / high-risk patients. */
  chronicExtraOffsetsMinutes: number[];
  quietHours: { startHour: number; endHour: number };
  /** Skip reminders younger than this many minutes before start. */
  minLeadMinutes: number;
  /** Pause all outbound messaging when this is true. */
  paused: boolean;
}

export interface FollowUpPolicy {
  enabled: boolean;
  defaultIntervalDays: number;
  /** Ask for readings this many hours after a window opens. */
  requestAfterHours: number;
  /** Escalate to the doctor if no reply within this many hours. */
  noReplyEscalationHours: number;
  maxRequestsPerWeek: number;
}

export interface BookingPolicy {
  enabled: boolean;
  minNoticeHours: number;
  maxAdvanceDays: number;
  /** Minutes reserved after a public booking before it is released. */
  holdMinutes: number;
  autoConfirmWithoutDeposit: boolean;
  requirePhoneVerification: boolean;
  allowWaitlistJoin: boolean;
  bufferMinutes: number;
}

export interface WhatsAppPolicy {
  enabled: boolean;
  provider: 'cloud' | 'baileys' | 'simulator';
  /** Optional per-tenant sender override, otherwise the global one is used. */
  senderPhoneId: string | null;
  displayName: string | null;
  /** Country dial code without '+' used to normalise patient numbers. */
  defaultDialCode: string;
  maxRetries: number;
  retryBackoffSeconds: number;
  sessionLabel: string | null;
  /** Names of staff members to notify for critical alerts. */
  alertRecipients: string[];
}

export interface AiPolicy {
  enabled: boolean;
  provider: 'openai_compatible' | 'ollama' | 'rules_only';
  model: string;
  temperature: number;
  /** When true, AI output is stored as a draft requiring doctor confirmation. */
  requireDoctorApproval: boolean;
  maxTokens: number;
  /** Disallow storing identifiers in prompts (privacy mode). */
  deIdentify: boolean;
}

export interface FinancePolicy {
  currency: string;
  defaultConsultationFeeMinor: number;
  taxPercent: number;
  receiptPrefix: string;
  /** Days before an unpaid invoice triggers a payment reminder. */
  paymentReminderAfterDays: number;
}

export interface NotificationPolicy {
  doctorAlertChannel: Channel;
  criticalAlertChannel: Channel;
  /** Also surface critical alerts as in-app notifications. */
  inApp: boolean;
  quietHours: { startHour: number; endHour: number };
}

export interface ClinicMember extends BaseEntity {
  userId: string;
  role: MemberRole;
  status: MemberStatus;
  /** Doctors can be scoped to specific appointment types / calendars. */
  isPrimaryDoctor: boolean;
  specialty: Specialty | null;
  consultationFeeMinor: number | null;
  capabilitiesOverride: Capability[] | null;
  invitedAt: string | null;
  joinedAt: string | null;
}

export interface WorkingHours {
  /** 0 = Sunday … 6 = Saturday (JS convention). */
  weekday: number;
  enabled: boolean;
  /** "HH:mm" in the clinic timezone. */
  start: string;
  end: string;
  breaks: { start: string; end: string; label: string }[];
}

export interface ClinicSchedule extends BaseEntity {
  workingHours: WorkingHours[];
  slotDurationMinutes: number;
  bufferMinutes: number;
  maxDailyAppointments: number | null;
  /** ISO dates (yyyy-mm-dd) fully blocked. */
  holidays: { date: string; label: string }[];
  /** Extra blocked windows, e.g. conferences. */
  blockedWindows: { date: string; start: string; end: string; label: string }[];
  slotIntervalMinutes: number;
  allowWalkIn: boolean;
}

export interface Patient extends BaseEntity {
  mrn: string;
  firstName: string;
  lastName: string;
  fullName: string;
  phone: string;
  /** Phone in E.164-ish form used for messaging. */
  whatsappNumber: string | null;
  email: string | null;
  nationalId: string | null;
  dateOfBirth: string | null;
  ageYears: number | null;
  sex: Sex;
  bloodGroup: BloodGroup;
  heightCm: number | null;
  weightKg: number | null;
  bmi: number | null;
  address: string | null;
  city: string | null;
  country: string | null;
  emergencyContactName: string | null;
  emergencyContactPhone: string | null;
  preferredLanguage: Language;
  whatsappOptIn: boolean;
  whatsappOptInAt: string | null;
  whatsappVerifiedAt: string | null;
  marketingOptIn: boolean;
  chronicConditions: string[];
  allergies: string[];
  currentMedications: string[];
  pastSurguries: string[];
  familyHistory: string[];
  notes: string | null;
  /** Contracted insurer (الجهة الضامنة) plus the patient's policy number. */
  insurerId: string | null;
  insurerPolicyNo: string | null;
  /** Free-text search blob kept in sync for fast lookup. */
  searchBlob: string;
  tags: string[];
  source: Source;
  isActive: boolean;
  archivedAt: string | null;
  lastVisitAt: string | null;
  nextAppointmentAt: string | null;
  balanceMinor: number;
  lastVitalsAt: string | null;
}

export interface PatientFlags {
  requireDeposit: boolean | null;
  whatsappReminders: boolean | null;
  medicationNotifications: boolean | null;
  chronicFollowUps: boolean | null;
  followUpProtocolId: string | null;
  reminderOffsetsMinutes: number[] | null;
  followUpIntervalDays: number | null;
  doNotContact: boolean;
  preferredChannel: Channel | null;
  vip: boolean;
  note: string | null;
}

export interface Appointment extends BaseEntity {
  patientId: string;
  /** Assigned clinician (clinic_members.id of a doctor). */
  doctorId: string | null;
  startsAt: string;
  endsAt: string;
  timezone: string;
  status: AppointmentStatus;
  reason: string | null;
  notes: string | null;
  visitType: 'consultation' | 'follow_up' | 'procedure' | 'teleconsult' | 'review';
  source: Source;
  /** Public bookings hold a slot until deposit/verification. */
  isPublicBooking: boolean;
  holdExpiresAt: string | null;
  depositRequiredMinor: number;
  depositPaidMinor: number;
  feeMinor: number;
  paidMinor: number;
  cancelledAt: string | null;
  cancelledBy: string | null;
  cancellationReason: string | null;
  checkedInAt: string | null;
  completedAt: string | null;
  rescheduledFromId: string | null;
  confirmationToken: string;
  createdBy: string | null;
  patientName: string;
  patientPhone: string;
  specialty: Specialty;
  /** Denormalised for calendar colouring. */
  doctorName: string | null;
}

export interface Reminder extends BaseEntity {
  appointmentId: string;
  patientId: string;
  channel: ReminderChannel;
  template: ReminderTemplate;
  scheduledFor: string;
  sentAt: string | null;
  status: ReminderStatus;
  offsetMinutes: number;
  /** 'global' or 'patient' — surfaces where the rule came from. */
  origin: 'global' | 'patient' | 'auto_cancelled';
  payload: Record<string, unknown>;
  attempts: number;
  lastError: string | null;
  messageId: string | null;
}

export interface WaitlistEntry extends BaseEntity {
  patientId: string;
  specialty: Specialty;
  doctorId: string | null;
  preferredDateFrom: string | null;
  preferredDateTo: string | null;
  preferredTimeWindows: { start: string; end: string }[];
  note: string | null;
  priority: number;
  status: 'waiting' | 'offered' | 'booked' | 'expired' | 'cancelled';
  /** Slot currently offered, if any. */
  offeredAppointmentId: string | null;
  offeredSlotStart: string | null;
  offeredSlotEnd: string | null;
  offerExpiresAt: string | null;
  offers: number;
  lastOfferedAt: string | null;
  patientName: string;
  patientPhone: string;
}

export interface OutboxMessage extends BaseEntity {
  channel: Channel;
  to: string;
  /** Rendered body, or template key + vars when `rendered` is false. */
  body: string;
  template: ReminderTemplate | 'custom' | 'critical_alert' | 'alert';
  payload: Record<string, unknown>;
  status: OutboxStatus;
  scheduledFor: string;
  attempts: number;
  maxAttempts: number;
  lastAttemptAt: string | null;
  sentAt: string | null;
  lastError: string | null;
  providerMessageId: string | null;
  appointmentId: string | null;
  patientId: string | null;
  /** Idempotency key so a retry can never double-send. */
  dedupeKey: string | null;
  lockedBy: string | null;
  lockedAt: string | null;
  correlationId: string | null;
  /**
   * Send ordering. Lower runs first. Safety-critical messages use 0 so a
   * critical alert is never stuck behind a backlog of queued reminders, which
   * `scheduledFor` alone cannot guarantee once both are due.
   */
  priority: number;
  /**
   * Set when the message is part of patient care rather than engagement.
   *
   * The consent sweep honours this instead of guessing from the template name:
   * a patient may opt out of reminders but must still be told their critical
   * blood-pressure reading came through.
   */
  safetyCritical: boolean;
}

export interface MessageThread {
  id: string;
  clinicId: string;
  patientId: string;
  channel: Channel;
  /** E.164 conversation key. */
  externalKey: string;
  lastMessageAt: string | null;
  lastPreview: string | null;
  unreadCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface Message extends BaseEntity {
  threadId: string;
  patientId: string;
  channel: Channel;
  direction: MessageDirection;
  status: MessageStatus;
  body: string;
  template: string | null;
  providerMessageId: string | null;
  externalMessageId: string | null;
  /** Set when the message was machine-parsed (e.g. a glucose reading). */
  parsedIntent: string | null;
  parsedPayload: Record<string, unknown> | null;
  mediaUrl: string | null;
  error: string | null;
  sentAt: string | null;
  deliveredAt: string | null;
  readAt: string | null;
  appointmentId: string | null;
  /** Who in the clinic sent it, for outbound messages. */
  sentBy: string | null;
  replyToMessageId: string | null;
}

export interface Diagnosis extends BaseEntity {
  patientId: string;
  appointmentId: string | null;
  code: string | null;
  /** e.g. "E11.9" */
  icdCode: string | null;
  title: string;
  description: string | null;
  status: 'active' | 'resolved' | 'chronic' | 'recurrence' | 'ruled_out';
  isChronic: boolean;
  diagnosedBy: string | null;
  diagnosedAt: string;
  resolvedAt: string | null;
  notes: string | null;
  source: Source;
}

export interface PrescriptionItem {
  drugId: string;
  genericName: string;
  brandName: string | null;
  strength: string;
  form: string | null;
  dose: string;
  route: string;
  frequency: string;
  durationDays: number | null;
  instructions: string | null;
  quantity: number | null;
  refills: number;
  startDate: string | null;
  endDate: string | null;
  /** Free text for drugs not in the catalog. */
  isOffCatalog: boolean;
  notes: string | null;
}

export interface Prescription extends BaseEntity {
  patientId: string;
  appointmentId: string | null;
  /** Sequential per clinic, used in the printed document. */
  number: string;
  issuedBy: string | null;
  issuedByName: string | null;
  issuedAt: string;
  items: PrescriptionItem[];
  diagnosisSummary: string | null;
  advice: string | null;
  investigations: string | null;
  followUpPlan: string | null;
  vitalsSnapshot: Record<string, number> | null;
  status: 'draft' | 'signed' | 'cancelled';
  signature: string | null;
  signedAt: string | null;
  pdfUrl: string | null;
  /** Set when the content was machine-generated and needs review. */
  aiGenerated: boolean;
  aiModel: string | null;
  sourceNoteId: string | null;
}

export interface MedicalDocument extends BaseEntity {
  patientId: string;
  appointmentId: string | null;
  kind: DocumentKind;
  title: string;
  storageKey: string;
  mimeType: string;
  sizeBytes: number;
  /** Previewable image derivative, if generated. */
  thumbnailUrl: string | null;
  pageCount: number | null;
  uploadedBy: string | null;
  notes: string | null;
  capturedAt: string | null;
  /** Extracted/AI-parsed findings. */
  ocrText: string | null;
  aiSummary: string | null;
  checksum: string | null;
}

export interface VitalReading extends BaseEntity {
  patientId: string;
  kind: VitalKind;
  value: number;
  secondaryValue: number | null;
  unit: string;
  /** free text: fasting / postprandial / random, arm, etc. */
  context: string | null;
  measuredAt: string;
  source: Source;
  recordedBy: string | null;
  messageId: string | null;
  followUpId: string | null;
  /** Persisted evaluation so historical rows keep their original verdict. */
  severity: AlertSeverity | null;
  isAbnormal: boolean;
  isCritical: boolean;
  interpretation: string | null;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
}

export interface VitalBundle {
  readings: { kind: VitalKind; value: number; secondaryValue?: number | null; unit: string; context?: string | null }[];
  measuredAt: string;
  source: Source;
}

export interface FollowUpProtocol extends BaseEntity {
  name: string;
  specialty: Specialty;
  description: string | null;
  /** Vitals to request, with the prompt used by the follow-up engine. */
  vitals: { kind: VitalKind; label: string; prompt: string; required: boolean; maxPerDay: number }[];
  intervalDays: number;
  /** Hour of day (clinic tz) at which the request is sent. */
  requestHour: number;
  active: boolean;
  isSystemDefault: boolean;
  /** Specialty templates are auto-applied when the clinic specialty matches. */
  appliesToSpecialty: Specialty | null;
}

export interface FollowUp extends BaseEntity {
  patientId: string;
  protocolId: string | null;
  diagnosisId: string | null;
  name: string;
  status: FollowUpStatus;
  /** What causes the next request to be generated. */
  trigger: FollowUpTrigger;
  intervalDays: number;
  startDate: string;
  endDate: string | null;
  nextDueAt: string;
  lastRequestedAt: string | null;
  lastResponseAt: string | null;
  requestsThisWeek: number;
  weekStamp: string | null;
  requestsSent: number;
  responsesReceived: number;
  consecutiveMisses: number;
  adherencePercent: number;
  pausedAt: string | null;
  pauseReason: string | null;
  notes: string | null;
  createdBy: string | null;
}

export interface ClinicalAlert extends BaseEntity {
  patientId: string | null;
  followUpId: string | null;
  readingId: string | null;
  appointmentId: string | null;
  kind: AlertKind;
  severity: AlertSeverity;
  status: AlertStatus;
  title: string;
  body: string;
  metric: string | null;
  value: number | null;
  threshold: string | null;
  acknowledgedBy: string | null;
  acknowledgedAt: string | null;
  resolvedAt: string | null;
  resolutionNote: string | null;
  readAt: string | null;
}

export interface Notification extends BaseEntity {
  userId: string;
  alertId: string | null;
  severity: AlertSeverity;
  title: string;
  body: string;
  href: string | null;
  readAt: string | null;
}

export interface PaymentLedgerEntry extends BaseEntity {
  patientId: string;
  appointmentId: string | null;
  invoiceId: string | null;
  type: TransactionType;
  direction: 'charge' | 'payment' | 'refund';
  amountMinor: number;
  currency: string;
  method: PaymentMethod | null;
  status: PaymentStatus;
  description: string;
  reference: string | null;
  performedBy: string | null;
  performedAt: string;
  isDeposit: boolean;
  note: string | null;
}

export interface Invoice extends BaseEntity {
  patientId: string;
  appointmentId: string | null;
  number: string;
  currency: string;
  subtotalMinor: number;
  discountMinor: number;
  taxMinor: number;
  totalMinor: number;
  paidMinor: number;
  status: PaymentStatus;
  dueDate: string | null;
  issuedBy: string | null;
  notes: string | null;
  paidAt: string | null;
  reminderSentAt: string | null;
}

export interface InvoiceLine {
  id: string;
  description: string;
  type: TransactionType;
  quantity: number;
  unitPriceMinor: number;
  totalMinor: number;
}

export interface ServiceItem {
  id: string;
  clinicId: string;
  name: string;
  type: TransactionType;
  priceMinor: number;
  durationMinutes: number | null;
  active: boolean;
  taxable: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface VoiceNote extends BaseEntity {
  patientId: string;
  appointmentId: string | null;
  storageKey: string | null;
  mimeType: string | null;
  durationSeconds: number | null;
  /** Raw transcript from browser speech recognition. */
  rawTranscript: string | null;
  /** Server-side transcription result when available. */
  transcript: string | null;
  /** Structured SOAP summary produced by the AI layer. */
  summary: ClinicalSummary | null;
  status: 'recorded' | 'transcribing' | 'summarized' | 'failed' | 'discarded';
  language: string | null;
  model: string | null;
  error: string | null;
  appliedAt: string | null;
  appliedBy: string | null;
}

export interface ClinicalSummary {
  chiefComplaint: string;
  historyOfPresentIllness: string;
  reviewOfSystems: string;
  pastHistory: string;
  medications: string[];
  allergies: string[];
  examination: string;
  investigations: string;
  assessment: string;
  diagnoses: { title: string; icdCode: string | null; isChronic: boolean }[];
  plan: string;
  drugSuggestions: DrugSuggestion[];
  advice: string;
  followUpPlan: string;
  redFlags: string[];
  /** Number of tokens / heuristic markers, shown in the UI. */
  confidence: number;
  generatedBy: 'ai' | 'rules';
  model: string | null;
  disclaimer: string;
}

export interface DrugSuggestion {
  drugId: string;
  genericName: string;
  brandNames: string[];
  class: string;
  strength: string;
  dose: string;
  frequency: string;
  durationDays: number | null;
  route: string;
  indication: string;
  rationale: string;
  renalCaution: string | null;
  hepaticCaution: string | null;
  monitoring: string[];
  contraindications: string[];
  interactionCount: number;
  maxDose: string | null;
}

export interface DrugInteraction {
  severity: 'contraindicated' | 'major' | 'moderate' | 'minor';
  drugA: string;
  drugB: string;
  mechanism: string;
  clinicalEffect: string;
  management: string;
  evidence: string;
  source: string;
}

export interface AllergyConflict {
  severity: 'contraindicated' | 'major' | 'moderate';
  drugId: string;
  drugName: string;
  allergen: string;
  class: string;
  crossReactivity: string | null;
  advice: string;
}

export interface DecisionSupportResult {
  /** Diagnosis suggestions keyed by score. */
  differential: { title: string; icdCode: string | null; score: number; supportingFeatures: string[] }[];
  suggestedRegimen: DrugSuggestion[];
  interactions: DrugInteraction[];
  allergyConflicts: AllergyConflict[];
  /** Contraindications found in the patient record. */
  contraindicationNotes: string[];
  dosingAdjustments: { drugId: string; drugName: string; note: string; severity: AlertSeverity }[];
  monitoring: { label: string; frequency: string; reason: string; kind: VitalKind | null }[];
  requiredInvestigations: string[];
  redFlags: string[];
  guidelineRefs: { title: string; source: string; url: string | null }[];
  /** Always true — the clinician must review before prescribing. */
  requiresClinicianReview: true;
  generatedBy: 'ai' | 'rules' | 'hybrid';
  model: string | null;
  disclaimer: string;
  contextUsed: string[];
}

export interface AuditLog extends BaseEntity {
  actorId: string | null;
  actorRole: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  metadata: Record<string, unknown>;
  ip: string | null;
  userAgent: string | null;
}

export interface Holiday extends BaseEntity {
  date: string;
  label: string;
  recurring: boolean;
  clinicWide: boolean;
}

export interface WhatsAppSession {
  id: string;
  clinicId: string;
  provider: 'baileys' | 'cloud' | 'simulator';
  status: 'disconnected' | 'connecting' | 'connected' | 'qr' | 'error';
  phoneNumber: string | null;
  qrCode: string | null;
  lastConnectedAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SyncDelta {
  changes: SyncEntity[];
  cursor: number;
  serverTime: string;
  hasMore: boolean;
}

export type SyncEntityKind =
  | 'patient'
  | 'patient_flags'
  | 'appointment'
  | 'reminder'
  | 'waitlist'
  | 'diagnosis'
  | 'prescription'
  | 'document'
  | 'vital'
  | 'followup'
  | 'alert'
  | 'invoice'
  | 'ledger'
  | 'message';

export interface SyncEntity {
  kind: SyncEntityKind;
  id: string;
  clinicId: string;
  /** Monotonic per-clinic version used for delta sync. */
  version: number;
  op: 'upsert' | 'delete';
  updatedAt: string;
  data: unknown;
}

export interface ClinicPublicProfile {
  name: string;
  slug: string;
  specialty: Specialty;
  specialtyLabel: string;
  doctorName: string;
  logoUrl: string | null;
  city: string | null;
  country: string | null;
  address: string | null;
  currency: string;
  locale: Language;
  intakeSide: 'ltr' | 'rtl';
  timezone: string;
  depositRequired: boolean;
  depositAmountMinor: number;
  bookingHorizonDays: number;
  minNoticeHours: number;
  slotDurationMinutes: number;
  phone: string | null;
  licenseNumber: string | null;
}

export interface PublicSlot {
  startsAt: string;
  endsAt: string;
  feeMinor: number;
  depositRequiredMinor: number;
  available: boolean;
}

export interface PublicDoctor {
  id: string;
  name: string;
  specialty: Specialty;
  photoUrl: string | null;
  feeMinor: number;
  about: string | null;
}

export interface Paginated<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
  nextCursor: number | null;
}

export interface DashboardStats {
  today: {
    date: string;
    total: number;
    completed: number;
    cancelled: number;
    noShow: number;
    remaining: number;
    nextAppointment: Appointment | null;
    revenueMinor: number;
  };
  week: { total: number; completed: number; cancelled: number; noShow: number };
  patients: { total: number; newThisMonth: number; activeChronic: number };
  messages: { queued: number; sentToday: number; failed: number; unreadThreads: number };
  alerts: { open: number; critical: number; unreadNotifications: number };
  revenue: { thisMonthMinor: number; lastMonthMinor: number; outstandingMinor: number };
  ai: { suggestionsGenerated: number; summariesCreated: number; acceptedRate: number };
  followUps: { active: number; dueToday: number; responseRate: number };
}

export interface AnalyticsReport {
  period: { from: string; to: string };
  appointments: { total: number; byStatus: Record<string, number>; noShowRate: number; cancellationRate: number; utilization: number; avgLeadDays: number };
  revenue: { totalMinor: number; collectedMinor: number; outstandingMinor: number; byMethod: { method: string; totalMinor: number; count: number }[]; byDay: { date: string; totalMinor: number; count: number }[] };
  patients: { total: number; newCount: number; bySpecialty: { specialty: string; count: number }[]; topDiagnoses: { title: string; count: number }[] };
  adherence: { followUps: number; responseRate: number; criticalAlerts: number; readingsLogged: number };
  channels: { whatsappSent: number; whatsappReplies: number; deliveryRate: number };
}

export interface BookingResult {
  appointment: Appointment;
  patient: Patient;
  depositRequired: boolean;
  depositAmountMinor: number;
  message: string;
}

export interface SortDirection {
  field: string;
  direction: 'asc' | 'desc';
}
