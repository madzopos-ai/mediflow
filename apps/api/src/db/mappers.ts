/**
 * Row to domain mapping.
 *
 * SQLite has no boolean or JSON type, so every conversion lives here rather
 * than being spread across route handlers. The two rules:
 *
 *   1. Booleans are stored as 0/1 integers.
 *   2. JSON columns are parsed once, defensively. A malformed JSON column must
 *      not crash a list endpoint, so a parse failure yields the type's empty
 *      value and the row is still returned.
 *
 * Column names are snake_case here and camelCase in the domain, which is the
 * only reason this file exists.
 */

import type {
  AlertSeverity,
  Channel,
  ClinicalAlert,
  FollowUp,
  Message,
  MessageDirection,
  MessageStatus,
  MessageThread,
  OutboxMessage,
  Patient,
  Reminder,
  ReminderStatus,
  Sex,
  Source,
  Specialty,
  Appointment,
  AppointmentStatus,
  BloodGroup,
  Language,
  VitalKind,
  VitalReading,
  WaitlistEntry,
} from '@mediflow/shared';

/** A database row with untyped columns. */
export type Row = Record<string, unknown>;

function str(row: Row, key: string): string {
  const value = row[key];
  return typeof value === 'string' ? value : String(value ?? '');
}

function strOrNull(row: Row, key: string): string | null {
  const value = row[key];
  return value === null || value === undefined ? null : String(value);
}

function num(row: Row, key: string): number {
  const value = Number(row[key]);
  return Number.isFinite(value) ? value : 0;
}

function numOrNull(row: Row, key: string): number | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function bool(row: Row, key: string): boolean {
  return num(row, key) !== 0;
}

export function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string' || raw === '') return fallback;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed === null || parsed === undefined ? fallback : (parsed as T);
  } catch {
    // A corrupt JSON column should degrade one field, not fail the request.
    return fallback;
  }
}

function base(row: Row): { id: string; clinicId: string; createdAt: string; updatedAt: string } {
  return {
    id: str(row, 'id'),
    clinicId: str(row, 'clinic_id'),
    createdAt: str(row, 'created_at'),
    updatedAt: str(row, 'updated_at'),
  };
}

export function toPatient(row: Row): Patient {
  return {
    ...base(row),
    mrn: str(row, 'mrn'),
    firstName: str(row, 'first_name'),
    lastName: str(row, 'last_name'),
    fullName: str(row, 'full_name'),
    phone: str(row, 'phone'),
    whatsappNumber: strOrNull(row, 'whatsapp_number'),
    email: strOrNull(row, 'email'),
    nationalId: strOrNull(row, 'national_id'),
    dateOfBirth: strOrNull(row, 'date_of_birth'),
    ageYears: numOrNull(row, 'age_years'),
    sex: str(row, 'sex') as Sex,
    bloodGroup: (strOrNull(row, 'blood_group') ?? 'unknown') as BloodGroup,
    heightCm: numOrNull(row, 'height_cm'),
    weightKg: numOrNull(row, 'weight_kg'),
    bmi: numOrNull(row, 'bmi'),
    address: strOrNull(row, 'address'),
    city: strOrNull(row, 'city'),
    country: strOrNull(row, 'country'),
    emergencyContactName: strOrNull(row, 'emergency_contact_name'),
    emergencyContactPhone: strOrNull(row, 'emergency_contact_phone'),
    preferredLanguage: str(row, 'preferred_language') as Language,
    whatsappOptIn: bool(row, 'whatsapp_opt_in'),
    whatsappOptInAt: strOrNull(row, 'whatsapp_opt_in_at'),
    whatsappVerifiedAt: strOrNull(row, 'whatsapp_verified_at'),
    marketingOptIn: bool(row, 'marketing_opt_in'),
    chronicConditions: parseJson<string[]>(row['chronic_conditions'], []),    allergies: parseJson<string[]>(row['allergies'], []),
    currentMedications: parseJson<string[]>(row['current_medications'], []),
    pastSurguries: parseJson<string[]>(row['past_surgeries'], []),
    familyHistory: parseJson<string[]>(row['family_history'], []),
    notes: strOrNull(row, 'notes'),
    insurerId: strOrNull(row, 'insurer_id'),
    insurerPolicyNo: strOrNull(row, 'insurer_policy_no'),
    searchBlob: str(row, 'search_blob'),
    tags: parseJson<string[]>(row['tags'], []),
    source: str(row, 'source') as Source,
    isActive: bool(row, 'is_active'),
    archivedAt: strOrNull(row, 'archived_at'),
    lastVisitAt: strOrNull(row, 'last_visit_at'),
    nextAppointmentAt: strOrNull(row, 'next_appointment_at'),
    balanceMinor: num(row, 'balance_minor'),
    lastVitalsAt: strOrNull(row, 'last_vitals_at'),
  };
}

export function toAppointment(row: Row): Appointment {
  return {
    ...base(row),
    patientId: str(row, 'patient_id'),
    doctorId: strOrNull(row, 'doctor_id'),
    startsAt: str(row, 'starts_at'),
    endsAt: str(row, 'ends_at'),
    timezone: str(row, 'timezone'),
    status: str(row, 'status') as AppointmentStatus,
    reason: strOrNull(row, 'reason'),
    notes: strOrNull(row, 'notes'),
    visitType: str(row, 'visit_type') as Appointment['visitType'],
    source: str(row, 'source') as Source,
    isPublicBooking: bool(row, 'is_public_booking'),
    holdExpiresAt: strOrNull(row, 'hold_expires_at'),
    depositRequiredMinor: num(row, 'deposit_required_minor'),
    depositPaidMinor: num(row, 'deposit_paid_minor'),
    feeMinor: num(row, 'fee_minor'),
    paidMinor: num(row, 'paid_minor'),
    cancelledAt: strOrNull(row, 'cancelled_at'),
    cancelledBy: strOrNull(row, 'cancelled_by'),
    cancellationReason: strOrNull(row, 'cancellation_reason'),
    checkedInAt: strOrNull(row, 'checked_in_at'),
    completedAt: strOrNull(row, 'completed_at'),
    rescheduledFromId: strOrNull(row, 'rescheduled_from_id'),
    confirmationToken: str(row, 'confirmation_token'),
    createdBy: strOrNull(row, 'created_by'),
    patientName: str(row, 'patient_name'),
    patientPhone: str(row, 'patient_phone'),
    specialty: str(row, 'specialty') as Specialty,
    doctorName: strOrNull(row, 'doctor_name'),
  };
}

export function toReminder(row: Row): Reminder {
  return {
    ...base(row),
    appointmentId: str(row, 'appointment_id'),
    patientId: str(row, 'patient_id'),
    channel: str(row, 'channel') as Reminder['channel'],
    template: str(row, 'template') as Reminder['template'],
    scheduledFor: str(row, 'scheduled_for'),
    sentAt: strOrNull(row, 'sent_at'),
    status: str(row, 'status') as ReminderStatus,
    offsetMinutes: num(row, 'offset_minutes'),
    origin: str(row, 'origin') as Reminder['origin'],
    payload: parseJson<Record<string, unknown>>(row['payload'], {}),
    attempts: num(row, 'attempts'),
    lastError: strOrNull(row, 'last_error'),
    messageId: strOrNull(row, 'message_id'),
  };
}

export function toVitalReading(row: Row): VitalReading {
  return {
    ...base(row),
    patientId: str(row, 'patient_id'),
    kind: str(row, 'kind') as VitalKind,
    value: num(row, 'value'),
    secondaryValue: numOrNull(row, 'secondary_value'),
    unit: str(row, 'unit'),
    context: strOrNull(row, 'context'),
    measuredAt: str(row, 'measured_at'),
    source: str(row, 'source') as Source,
    recordedBy: strOrNull(row, 'recorded_by'),
    messageId: strOrNull(row, 'message_id'),
    followUpId: strOrNull(row, 'follow_up_id'),
    severity: (strOrNull(row, 'severity') ?? null) as AlertSeverity | null,
    isAbnormal: bool(row, 'is_abnormal'),
    isCritical: bool(row, 'is_critical'),
    interpretation: strOrNull(row, 'interpretation'),
    acknowledgedAt: strOrNull(row, 'acknowledged_at'),
    acknowledgedBy: strOrNull(row, 'acknowledged_by'),
  };
}

export function toClinicalAlert(row: Row): ClinicalAlert {
  return {
    ...base(row),
    patientId: strOrNull(row, 'patient_id'),
    followUpId: strOrNull(row, 'follow_up_id'),
    readingId: strOrNull(row, 'reading_id'),
    appointmentId: strOrNull(row, 'appointment_id'),
    kind: str(row, 'kind') as ClinicalAlert['kind'],
    severity: str(row, 'severity') as AlertSeverity,
    status: str(row, 'status') as ClinicalAlert['status'],
    title: str(row, 'title'),
    body: str(row, 'body'),
    metric: strOrNull(row, 'metric'),
    value: numOrNull(row, 'value'),
    threshold: strOrNull(row, 'threshold'),
    acknowledgedBy: strOrNull(row, 'acknowledged_by'),
    acknowledgedAt: strOrNull(row, 'acknowledged_at'),
    resolvedAt: strOrNull(row, 'resolved_at'),
    resolutionNote: strOrNull(row, 'resolution_note'),
    readAt: strOrNull(row, 'read_at'),
  };
}

export function toFollowUp(row: Row): FollowUp {
  return {
    ...base(row),
    patientId: str(row, 'patient_id'),
    protocolId: strOrNull(row, 'protocol_id'),
    diagnosisId: strOrNull(row, 'diagnosis_id'),
    name: str(row, 'name'),
    status: str(row, 'status') as FollowUp['status'],
    trigger: str(row, 'trigger') as FollowUp['trigger'],
    intervalDays: num(row, 'interval_days'),
    startDate: str(row, 'start_date'),
    endDate: strOrNull(row, 'end_date'),
    nextDueAt: str(row, 'next_due_at'),
    lastRequestedAt: strOrNull(row, 'last_requested_at'),
    lastResponseAt: strOrNull(row, 'last_response_at'),
    requestsThisWeek: num(row, 'requests_this_week'),
    weekStamp: strOrNull(row, 'week_stamp'),
    requestsSent: num(row, 'requests_sent'),
    responsesReceived: num(row, 'responses_received'),
    consecutiveMisses: num(row, 'consecutive_misses'),
    adherencePercent: num(row, 'adherence_percent'),
    pausedAt: strOrNull(row, 'paused_at'),
    pauseReason: strOrNull(row, 'pause_reason'),
    notes: strOrNull(row, 'notes'),
    createdBy: strOrNull(row, 'created_by'),
  };
}

export function toWaitlistEntry(row: Row): WaitlistEntry {
  return {
    ...base(row),
    patientId: str(row, 'patient_id'),
    specialty: str(row, 'specialty') as Specialty,
    doctorId: strOrNull(row, 'doctor_id'),
    preferredDateFrom: strOrNull(row, 'preferred_date_from'),
    preferredDateTo: strOrNull(row, 'preferred_date_to'),
    preferredTimeWindows: parseJson<{ start: string; end: string }[]>(row['preferred_time_windows'], []),
    note: strOrNull(row, 'note'),
    priority: num(row, 'priority'),
    status: str(row, 'status') as WaitlistEntry['status'],
    offeredAppointmentId: strOrNull(row, 'offered_appointment_id'),
    offeredSlotStart: strOrNull(row, 'offered_slot_start'),
    offeredSlotEnd: strOrNull(row, 'offered_slot_end'),
    offerExpiresAt: strOrNull(row, 'offer_expires_at'),
    offers: num(row, 'offers'),
    lastOfferedAt: strOrNull(row, 'last_offered_at'),
    patientName: str(row, 'patient_name'),
    patientPhone: str(row, 'patient_phone'),
  };
}

export function toOutboxMessage(row: Row): OutboxMessage {
  return {
    ...base(row),
    channel: str(row, 'channel') as Channel,
    to: str(row, 'to_phone'),
    body: str(row, 'body'),
    template: str(row, 'template') as OutboxMessage['template'],
    payload: parseJson<Record<string, unknown>>(row['payload'], {}),
    status: str(row, 'status') as OutboxMessage['status'],
    scheduledFor: str(row, 'scheduled_for'),
    attempts: num(row, 'attempts'),
    maxAttempts: num(row, 'max_attempts'),
    lastAttemptAt: strOrNull(row, 'last_attempt_at'),
    sentAt: strOrNull(row, 'sent_at'),
    lastError: strOrNull(row, 'last_error'),
    providerMessageId: strOrNull(row, 'provider_message_id'),
    appointmentId: strOrNull(row, 'appointment_id'),
    patientId: strOrNull(row, 'patient_id'),
    dedupeKey: strOrNull(row, 'dedupe_key'),
    lockedBy: strOrNull(row, 'locked_by'),
    lockedAt: strOrNull(row, 'locked_at'),
    correlationId: strOrNull(row, 'correlation_id'),
    priority: num(row, 'priority'),
    safetyCritical: num(row, 'safety_critical') === 1,
  };
}

export function toMessageThread(row: Row): MessageThread {
  return {
    id: str(row, 'id'),
    clinicId: str(row, 'clinic_id'),
    patientId: str(row, 'patient_id'),
    channel: str(row, 'channel') as Channel,
    externalKey: str(row, 'external_key'),
    lastMessageAt: strOrNull(row, 'last_message_at'),
    lastPreview: strOrNull(row, 'last_preview'),
    unreadCount: num(row, 'unread_count'),
    createdAt: str(row, 'created_at'),
    updatedAt: str(row, 'updated_at'),
  };
}

export function toMessage(row: Row): Message {
  return {
    ...base(row),
    threadId: str(row, 'thread_id'),
    patientId: str(row, 'patient_id'),
    channel: str(row, 'channel') as Channel,
    direction: str(row, 'direction') as MessageDirection,
    status: str(row, 'status') as MessageStatus,
    body: str(row, 'body'),
    template: strOrNull(row, 'template'),
    providerMessageId: strOrNull(row, 'provider_message_id'),
    externalMessageId: strOrNull(row, 'external_message_id'),
    parsedIntent: strOrNull(row, 'parsed_intent'),
    parsedPayload: parseJson<Record<string, unknown> | null>(row['parsed_payload'], null),
    mediaUrl: strOrNull(row, 'media_url'),
    error: strOrNull(row, 'error'),
    sentAt: strOrNull(row, 'sent_at'),
    deliveredAt: strOrNull(row, 'delivered_at'),
    readAt: strOrNull(row, 'read_at'),
    appointmentId: strOrNull(row, 'appointment_id'),
    sentBy: strOrNull(row, 'sent_by'),
    replyToMessageId: strOrNull(row, 'reply_to_message_id'),
  };
}

// ---------------------------------------------------------------------------
// Domain to column helpers, for writes.
// ---------------------------------------------------------------------------

export function jsonColumn(value: unknown): string {
  return JSON.stringify(value ?? null);
}

/** 1/0 from a boolean, for SQL parameters. */
export function bit(value: boolean | null | undefined): number {
  return value ? 1 : 0;
}

export function nullable(value: string | null | undefined): string | null {
  return value === undefined || value === '' ? null : value;
}
