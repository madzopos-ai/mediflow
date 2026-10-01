/**
 * Inbound WhatsApp handling.
 *
 * This is the highest-risk path in the system: an unauthenticated caller can
 * post a message that a clinician will read, and a mis-parsed reading can
 * trigger a patient-safety alert. Three rules follow from that:
 *
 *   1. The clinic is resolved from the provider's phone-number id, never from
 *      the request body.
 *   2. Consent changes only ever move toward *less* messaging. An inbound
 *      "STOP" is honoured; a staff action cannot silently re-subscribe someone.
 *   3. A critical reading creates an alert for a human. It is never
 *      auto-resolved, and the automated reply to the patient explicitly says a
 *      clinician will contact them.
 */

import {
  createId,
  evaluateParsed,
  isValidE164,
  normalizePhone,
  requiresHumanReview,
  routeInbound,
  vitalLabel,
  type InboundIntent,
  type ParsedReply,
  type Patient,
} from '@mediflow/shared';

import type { TenantHandle } from '../db/tenant.js';
import type { Db } from '../db/index.js';
import { bit, nullable, type Row } from '../db/mappers.js';
import { createPatient, findByPhone } from './patients.js';
import { createMessage, ensureThread, threadKey } from './threads.js';
import { queueOutbound } from './outbox.js';
import { syncPatientActivity } from './activity.js';
import { ApiError } from '../http/errors.js';

export interface InboundResult {
  ok: boolean;
  duplicate: boolean;
  patientId: string;
  messageId: string;
  intent: InboundIntent['kind'];
  requiresHuman: boolean;
  readingIds: string[];
  alertId: string | null;
  queuedReplies: number;
  consentChanged: 'opted_out' | 'opted_in' | null;
}

/** Map a provider phone-number id to a clinic, falling back to a single tenant. */
export function resolveClinicForProvider(db: Db, phoneNumberId: string): string {
  const row = db
    .prepare("SELECT clinic_id FROM clinic_settings WHERE json LIKE ? LIMIT 1")
    .get(`%"senderPhoneId":"${phoneNumberId}"%`) as { clinic_id: string } | undefined;
  if (row) return row.clinic_id;

  const clinics = db.prepare('SELECT id FROM clinics ORDER BY created_at ASC LIMIT 2').all() as {
    id: string;
  }[];
  // More than one clinic means the provider id is genuinely ambiguous, and
  // guessing would route a patient's medical message to the wrong clinic.
  if (clinics.length === 1 && clinics[0]) return clinics[0].id;
  throw ApiError.badRequest('No clinic is configured for that phone number id.');
}

interface RecordReadingsOptions {
  criticalValueAlerts: boolean;
  clinicTimezone: string;
  messageId: string | null;
}

/**
 * Persist parsed readings and raise alerts for critical values.
 *
 * `evaluateParsed` is the shared threshold engine, so a reading arriving by
 * WhatsApp is judged exactly the same as one entered by a nurse.
 */
export function recordReadings(
  tenant: TenantHandle,
  clinicId: string,
  patient: Patient,
  parse: ParsedReply,
  now: string,
  options: RecordReadingsOptions,
): { readingIds: string[]; alertId: string | null } {
  if (!parse.hasReading || parse.readings.length === 0) return { readingIds: [], alertId: null };

  const evaluations = evaluateParsed(parse, {
    ageYears: patient.ageYears,
    sex: patient.sex,
    source: 'whatsapp_inbound',
  });

  const readingIds: string[] = [];
  let alertId: string | null = null;

  for (const reading of parse.readings) {
    const evaluation = evaluations.find((e) => e.kind === reading.kind);
    const isCritical = evaluation?.severity === 'critical';
    // 'info' is the lowest severity, so anything at info is within range.
    const isAbnormal = evaluation ? evaluation.severity !== 'info' : false;

    const id = createId('vit');
    tenant.insert('vital_readings', {
      id,
      clinic_id: clinicId,
      patient_id: patient.id,
      kind: reading.kind,
      value: reading.value,
      secondary_value: reading.secondaryValue,
      unit: reading.unit,
      context: nullable(reading.context),
      measured_at: now,
      source: 'whatsapp_inbound',
      recorded_by: null,
      message_id: options.messageId,
      follow_up_id: null,
      severity: evaluation?.severity ?? null,
      is_abnormal: bit(isAbnormal),
      is_critical: bit(isCritical),
      interpretation: evaluation?.interpretation ?? null,
      acknowledged_at: null,
      acknowledged_by: null,
      created_at: now,
      updated_at: now,
    });
    readingIds.push(id);

    if (isCritical && options.criticalValueAlerts) {
      alertId = createId('alt');
      const label = vitalLabel(reading.kind);

      tenant.insert('clinical_alerts', {
        id: alertId,
        clinic_id: clinicId,
        patient_id: patient.id,
        follow_up_id: null,
        reading_id: id,
        appointment_id: null,
        kind: 'vital_critical',
        severity: 'critical',
        // Stays 'open': a clinician must acknowledge and resolve it.
        status: 'open',
        title: `Critical ${label} reading`,
        body:
          `${patient.fullName} reported ${label} ${formatReading(reading.value, reading.secondaryValue, reading.unit)} ` +
          `via WhatsApp. ${evaluation?.interpretation ?? ''}`.trim(),
        metric: reading.kind,
        value: reading.value,
        threshold: evaluation?.referenceRange ?? null,
        acknowledged_by: null,
        acknowledged_at: null,
        resolved_at: null,
        resolution_note: null,
        read_at: null,
        created_at: now,
        updated_at: now,
      });

      notifyStaff(tenant, clinicId, alertId, patient, reading, evaluation?.interpretation ?? null, now);
    }
  }

  syncPatientActivity(tenant, patient.id, now);
  return { readingIds, alertId };
}

function formatReading(value: number, secondary: number | null, unit: string): string {
  return secondary === null || secondary === undefined
    ? `${value} ${unit}`
    : `${value}/${secondary} ${unit}`;
}

/** Fan a critical alert out to the clinic's clinical staff as notifications. */
function notifyStaff(
  tenant: TenantHandle,
  clinicId: string,
  alertId: string,
  patient: Patient,
  reading: { kind: string; value: number; secondaryValue: number | null; unit: string },
  interpretation: string | null,
  now: string,
): void {
  const staff = tenant.all<Row>("users", "role IN ('owner', 'doctor', 'nurse') AND is_active = 1");
  const title = `Critical ${reading.kind}: ${patient.fullName}`;
  const body = `${formatReading(reading.value, reading.secondaryValue, reading.unit)}${
    interpretation ? ` - ${interpretation}` : ''
  }`;

  for (const member of staff) {
    tenant.insert('notifications', {
      id: createId('ntf'),
      clinic_id: clinicId,
      user_id: String(member['id']),
      alert_id: alertId,
      severity: 'critical',
      title,
      body,
      href: `/patients/${patient.id}`,
      read_at: null,
      created_at: now,
      updated_at: now,
    });
  }
}

export interface ProcessInboundOptions {
  db: Db;
  tenant: TenantHandle;
  clinicId: string;
  from: string;
  body: string;
  defaultDialCode: string;
  clinicTimezone: string;
  criticalValueAlerts: boolean;
  patientName?: string;
  externalMessageId?: string;
  receivedAt?: string;
}

export function processInbound(options: ProcessInboundOptions): InboundResult {
  const { tenant, clinicId, from, body } = options;
  const now = options.receivedAt ?? new Date().toISOString();

  // Duplicate delivery: the provider retries on any non-2xx, so the same
  // external id must not become two messages or two alerts.
  if (options.externalMessageId) {
    const dupe = tenant.find<Row>('messages', 'external_message_id = ?', [options.externalMessageId]);
    if (dupe) {
      return {
        ok: true,
        duplicate: true,
        patientId: String(dupe['patient_id']),
        messageId: String(dupe['id']),
        // A row written by an older version may hold anything; the value is
        // only echoed back to staff, so a fallback beats a crash here.
        intent: (String(dupe['parsed_intent'] ?? 'unrecognised') as InboundIntent['kind']),
        requiresHuman: false,
        readingIds: [],
        alertId: null,
        queuedReplies: 0,
        consentChanged: null,
      };
    }
  }

  let patient = findByPhone(tenant, from);
  if (!patient) {
    // An unknown sender still gets a record, otherwise every first-time
    // contact is silently dropped. Staff can merge or archive it later.
    const name = options.patientName?.trim() || `WhatsApp ${from.slice(-4)}`;
    const parts = name.split(/\s+/);
    patient = createPatient(
      tenant,
      clinicId,
      {
        firstName: parts[0] || 'Unknown',
        lastName: parts.slice(1).join(' ') || 'Caller',
        fullName: name,
        phone: from,
        whatsappNumber: from,
        whatsappOptIn: true,
        source: 'whatsapp_inbound',
      },
      options.defaultDialCode,
    );
  }

  // One thread per patient per channel, so a patient messaging from two
  // numbers for the same record does not fragment the conversation.
  const threadId = ensureThread(tenant, clinicId, patient.id, threadKey(patient.id, 'whatsapp'), body, now, true);
  const intent = routeInbound(body, {
    ageYears: patient.ageYears,
    sex: patient.sex,
    source: 'whatsapp_inbound',
    measuredAt: now,
  });

  const parse: ParsedReply | null =
    intent.kind === 'vitals' || intent.kind === 'opt_out_with_readings' || intent.kind === 'unrecognised'
      ? intent.parse
      : null;

  const messageId = createMessage(tenant, clinicId, {
    threadId,
    patientId: patient.id,
    channel: 'whatsapp',
    direction: 'inbound',
    status: 'received',
    body,
    externalMessageId: options.externalMessageId ?? null,
    parsedIntent: intent.kind,
    parsedPayload: parse,
    now,
  });

  // Consent first, and only downward. `opt_out_with_readings` still opts out.
  let consentChanged: InboundResult['consentChanged'] = null;
  if (intent.kind === 'opt_out' || intent.kind === 'opt_out_with_readings') {
    tenant.update('patients', patient.id, {
      whatsapp_opt_in: 0,
      whatsapp_opt_in_at: null,
      marketing_opt_in: 0,
      updated_at: now,
    });
    patient = { ...patient, whatsappOptIn: false, marketingOptIn: false };
    consentChanged = 'opted_out';
  } else if (intent.kind === 'opt_in') {
    tenant.update('patients', patient.id, { whatsapp_opt_in: 1, whatsapp_opt_in_at: now, updated_at: now });
    patient = { ...patient, whatsappOptIn: true };
    consentChanged = 'opted_in';
  }

  const { readingIds, alertId } = parse
    ? recordReadings(tenant, clinicId, patient, parse, now, {
        criticalValueAlerts: options.criticalValueAlerts,
        clinicTimezone: options.clinicTimezone,
        messageId,
      })
    : { readingIds: [], alertId: null };

  const requiresHuman = requiresHumanReview(intent);
  let queuedReplies = 0;

  // Safety messages ignore opt-out: a patient who sent a critical reading has
  // to be told a clinician is coming, even if they later muted the clinic.
  if (alertId) {
    queuedReplies +=
      queueSafetyReply(
        tenant,
        { to: from, patientId: patient.id, language: patient.preferredLanguage },
        now,
      );
  } else if (!requiresHuman) {
    const reply = safeReplyFor(intent, patient.preferredLanguage);
    if (reply && patient.whatsappOptIn) {
      queueOutbound(tenant, {
        to: from,
        body: reply,
        template: 'custom',
        channel: 'whatsapp',
        patientId: patient.id,
        now,
      });
      queuedReplies += 1;
    }
  }

  return {
    ok: true,
    duplicate: false,
    patientId: patient.id,
    messageId,
    intent: intent.kind,
    requiresHuman,
    readingIds,
    alertId,
    queuedReplies,
    consentChanged,
  };
}

/**
 * The automated reply to a critical reading.
 *
 * Deliberately does not give clinical advice or a numeric instruction beyond
 * "seek urgent care if you have symptoms", because a bot reading a number off
 * WhatsApp is not a clinician.
 */
function queueSafetyReply(
  tenant: TenantHandle,
  target: { to: string; patientId: string; language: string },
  now: string,
): number {
  const arabic = target.language === 'ar';
  const body = arabic
    ? 'شكرًا لرسالِ قراءتك. تم إبلاغ الطبيب فورًا وسيتواصل معك. إذا كان الألم شديدًا أو تحسّ ضيقًا في التنفس أو ألمًا في الصدر، فتوجّه إلى الطوارئ الآن.'
    : 'Thank you for sending your reading. Your doctor has been alerted and will contact you. If you have severe pain, chest pain, or difficulty breathing, please seek emergency care now.';

  const queued = queueOutbound(tenant, {
    to: target.to,
    body,
    template: 'vitals_critical_alert',
    channel: 'whatsapp',
    patientId: target.patientId,
    now,
    // Bypasses quiet hours and the marketing opt-out. A patient who has muted
    // the clinic is still entitled to be told a clinician is on the way.
    safetyCritical: true,
  });

  // 1 when a message was newly enqueued, 0 when a dedupe key suppressed it.
  return queued.enqueued ? 1 : 0;
}

/**
 * Conservative auto-replies.
 *
 * Only intents with a single unambiguous meaning get one. An unrecognised
 * message gets nothing: a wrong guess in a clinical chat is worse than
 * silence, and the message is already sitting unread in the inbox.
 */
function safeReplyFor(intent: InboundIntent, language: string): string | null {
  const arabic = language === 'ar';
  switch (intent.kind) {
    case 'opt_in':
      return arabic
        ? 'تم تسجيل اشتراكك. شكرًا لك.'
        : 'You are subscribed. Thank you.';
    case 'opt_out':
    case 'opt_out_with_readings':
      return arabic
        ? 'تم إيقاف الرسائل. أتمنالك الصحة.'
        : 'You have been unsubscribed. Take care.';
    case 'help':
      return arabic
        ? 'يمكنك الإرسال: تأكيد، إلغاء، إعادة جدولة، أو رقم قراءتك مثل ١٢٠/٨٠. وإذا رغبت التحدث مع شخص، اطلب موظف الاستقبال.'
        : 'You can send: confirm, cancel, reschedule, or a reading such as 120/80. To speak to a person, ask for a receptionist.';
    case 'human_handover':
      return arabic
        ? 'جارٍ تحويلك إلى أحد موظفي العيادة. سيصلك رد قريبًا.'
        : 'Connecting you with a clinic staff member now. Someone will reply shortly.';
    default:
      return null;
  }
}

/** Validate and normalise an inbound sender number. */
export function normalizeSender(raw: string, defaultDialCode: string): string {
  const from = normalizePhone(raw, defaultDialCode);
  if (!from || !isValidE164(from)) {
    throw ApiError.badRequest('Sender number is not a valid international number.');
  }
  return from;
}
