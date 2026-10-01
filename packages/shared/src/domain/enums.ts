/**
 * Core domain enumerations and shared literal types.
 * Every identifier here is persisted in the database, so values are frozen.
 */

export const APPOINTMENT_STATUSES = [
  'scheduled',
  'confirmed',
  'checked_in',
  'in_progress',
  'completed',
  'cancelled',
  'no_show',
  'rescheduled',
] as const;
export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number];

/** Statuses that still occupy the calendar slot. */
export const BLOCKING_APPOINTMENT_STATUSES: readonly AppointmentStatus[] = [
  'scheduled',
  'confirmed',
  'checked_in',
  'in_progress',
  'completed',
];

export const REMINDER_CHANNELS = ['whatsapp', 'sms', 'email', 'in_app'] as const;
export type ReminderChannel = (typeof REMINDER_CHANNELS)[number];

export const REMINDER_STATUSES = ['scheduled', 'sent', 'failed', 'cancelled', 'skipped'] as const;
export type ReminderStatus = (typeof REMINDER_STATUSES)[number];

export const REMINDER_TEMPLATES = [
  'appointment_confirm',
  'appointment_cancel',
  'appointment_reschedule',
  'appointment_reminder',
  'medication_schedule',
  'vitals_request',
  'vitals_ack',
  'vitals_critical_alert',
  'waitlist_slot_offer',
  'followup_checkin',
  'payment_reminder',
  'birthday_wish',
  'custom',
] as const;
export type ReminderTemplate = (typeof REMINDER_TEMPLATES)[number];

export const MESSAGE_STATUSES = [
  'queued',
  'sending',
  'sent',
  'delivered',
  'read',
  'failed',
  'cancelled',
] as const;
export type MessageStatus = (typeof MESSAGE_STATUSES)[number];

export const MESSAGE_DIRECTIONS = ['outbound', 'inbound'] as const;
export type MessageDirection = (typeof MESSAGE_DIRECTIONS)[number];

export const OUTBOX_STATUSES = ['pending', 'processing', 'sent', 'failed', 'dead'] as const;
export type OutboxStatus = (typeof OUTBOX_STATUSES)[number];

export const CHANNELS = ['whatsapp', 'sms', 'email', 'in_app'] as const;
export type Channel = (typeof CHANNELS)[number];

export const SPECIALTIES = [
  'general_medicine',
  'endocrinology',
  'cardiology',
  'dentistry',
  'pediatrics',
  'dermatology',
  'gynecology',
  'orthopedics',
  'ophthalmology',
  'psychiatry',
  'pulmonology',
  'gastroenterology',
  'neurology',
  'nephrology',
  'rheumatology',
  'hematology',
  'oncology',
  'urology',
  'ent',
  'nutrition',
  'physiotherapy',
  'other',
] as const;
export type Specialty = (typeof SPECIALTIES)[number];

export const SPECIALTY_LABELS: Record<Specialty, string> = {
  general_medicine: 'General Medicine',
  endocrinology: 'Endocrinology',
  cardiology: 'Cardiology',
  dentistry: 'Dentistry',
  pediatrics: 'Pediatrics',
  dermatology: 'Dermatology',
  gynecology: 'Gynecology & Obstetrics',
  orthopedics: 'Orthopedics',
  ophthalmology: 'Ophthalmology',
  psychiatry: 'Psychiatry',
  pulmonology: 'Pulmonology',
  gastroenterology: 'Gastroenterology',
  neurology: 'Neurology',
  nephrology: 'Nephrology',
  rheumatology: 'Rheumatology',
  hematology: 'Hematology',
  oncology: 'Oncology',
  urology: 'Urology',
  ent: 'ENT',
  nutrition: 'Nutrition & Dietetics',
  physiotherapy: 'Physiotherapy',
  other: 'Other',
};

export const SEXES = ['female', 'male', 'intersex', 'unknown'] as const;
export type Sex = (typeof SEXES)[number];

export const BLOOD_GROUPS = [
  'A+',
  'A-',
  'B+',
  'B-',
  'AB+',
  'AB-',
  'O+',
  'O-',
  'unknown',
] as const;
export type BloodGroup = (typeof BLOOD_GROUPS)[number];

export const MEMBER_ROLES = ['owner', 'doctor', 'nurse', 'assistant', 'receptionist', 'billing'] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];

export const MEMBER_STATUSES = ['active', 'invited', 'suspended'] as const;
export type MemberStatus = (typeof MEMBER_STATUSES)[number];

/** Ordered least-privileged -> most-privileged. Used by `hasAtLeast`. */
export const ROLE_RANK: Record<MemberRole, number> = {
  receptionist: 10,
  billing: 20,
  assistant: 30,
  nurse: 40,
  doctor: 60,
  owner: 100,
};

export function hasAtLeast(role: MemberRole, required: MemberRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[required];
}

/** Capability matrix for fine-grained, per-tenant feature gating. */
export const CAPABILITIES = [
  'patients:read',
  'patients:write',
  'clinical:read',
  'clinical:write',
  'prescriptions:write',
  'appointments:read',
  'appointments:write',
  'billing:read',
  'billing:write',
  'whatsapp:read',
  'whatsapp:write',
  'analytics:read',
  'settings:read',
  'settings:write',
  'staff:manage',
] as const;
export type Capability = (typeof CAPABILITIES)[number];

const ROLE_CAPABILITIES: Record<MemberRole, readonly Capability[]> = {
  owner: CAPABILITIES,
  doctor: [
    'patients:read',
    'patients:write',
    'clinical:read',
    'clinical:write',
    'prescriptions:write',
    'appointments:read',
    'appointments:write',
    'billing:read',
    'whatsapp:read',
    'whatsapp:write',
    'analytics:read',
    'settings:read',
  ],
  nurse: [
    'patients:read',
    'patients:write',
    'clinical:read',
    'clinical:write',
    'appointments:read',
    'appointments:write',
    'whatsapp:read',
    'whatsapp:write',
  ],
  assistant: [
    'patients:read',
    'patients:write',
    'appointments:read',
    'appointments:write',
    'billing:read',
    'whatsapp:read',
    'whatsapp:write',
  ],
  receptionist: [
    'patients:read',
    'patients:write',
    'appointments:read',
    'appointments:write',
    'billing:read',
    'billing:write',
    'whatsapp:read',
    'whatsapp:write',
  ],
  billing: ['patients:read', 'billing:read', 'billing:write', 'analytics:read', 'whatsapp:read'],
};

export function capabilitiesForRole(role: MemberRole): readonly Capability[] {
  return ROLE_CAPABILITIES[role];
}

export function roleCan(role: MemberRole, capability: Capability): boolean {
  return ROLE_CAPABILITIES[role].includes(capability);
}

export const PAYMENT_METHODS = ['cash', 'card', 'wallet', 'transfer', 'insurance', 'waiver', 'whish'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const PAYMENT_STATUSES = ['pending', 'partial', 'paid', 'refunded', 'failed', 'waived'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

/** Local "wish money" / "Araboon" style deposits collected before the visit. */
export const DEPOSIT_METHODS = ['cash', 'wish_money', 'online', 'none'] as const;
export type DepositMethod = (typeof DEPOSIT_METHODS)[number];

export const TRANSACTION_TYPES = [
  'consultation',
  'procedure',
  'lab',
  'imaging',
  'medication',
  'procedure_package',
  'discount',
  'refund',
  'deposit_hold',
  'deposit_release',
] as const;
export type TransactionType = (typeof TRANSACTION_TYPES)[number];

export const VITAL_KINDS = [
  'fasting_glucose',
  'random_glucose',
  'postprandial_glucose',
  'hba1c',
  'systolic_bp',
  'diastolic_bp',
  'pulse',
  'temperature',
  'spo2',
  'respiratory_rate',
  'weight',
  'height',
  'bmi',
  'creatinine',
  'serum_potassium',
  'ldl',
  'hdl',
  'triglycerides',
  'hemoglobin',
  'wbc',
  'rbc',
  'hematocrit',
  'platelets',
  'mcv',
  'mch',
  'esr',
  'crp',
  'urea',
  'microalbumin',
  'urine_acr',
] as const;
export type VitalKind = (typeof VITAL_KINDS)[number];

export const FOLLOW_UP_STATUSES = ['active', 'paused', 'completed', 'cancelled'] as const;
export type FollowUpStatus = (typeof FOLLOW_UP_STATUSES)[number];

export const FOLLOW_UP_TRIGGERS = ['interval', 'reading_received', 'missed_reading', 'appointment_completed'] as const;
export type FollowUpTrigger = (typeof FOLLOW_UP_TRIGGERS)[number];

export const ALERT_SEVERITIES = ['info', 'warning', 'critical'] as const;
export type AlertSeverity = (typeof ALERT_SEVERITIES)[number];

export const ALERT_STATUSES = ['open', 'acknowledged', 'resolved'] as const;
export type AlertStatus = (typeof ALERT_STATUSES)[number];

export const ALERT_KINDS = [
  'critical_vital',
  'missed_reading',
  'treatment_adherence',
  'no_show',
  'failed_message',
  'ai_flag',
  'system',
] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];

export const DOCUMENT_KINDS = [
  'xray',
  'ct',
  'mri',
  'ultrasound',
  'lab_report',
  'prescription_scan',
  'referral',
  'consent_form',
  'photo',
  'invoice',
  'voice_note',
  'other',
] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

export const SOURCES = ['staff', 'whatsapp_inbound', 'ai', 'public_booking', 'patient_app', 'import', 'system'] as const;
export type Source = (typeof SOURCES)[number];

export const INTAKE_SIDES = ['ltr', 'rtl'] as const;
export type IntakeSide = (typeof INTAKE_SIDES)[number];

export const LANGUAGES = ['en', 'ar'] as const;
export type Language = (typeof LANGUAGES)[number];

/** Low stock threshold for medications dispensed from the clinic. */
export const DEFAULT_LOW_STOCK_THRESHOLD = 10;
