/**
 * Reminder scheduling and dispatch.
 *
 * Two jobs, deliberately separated:
 *
 *   1. `scheduleAppointmentReminders` plans reminders when an appointment is
 *      booked or rescheduled, using the shared pure planner. No database writes
 *      beyond persisting the plan, so it is fully deterministic.
 *   2. `queueDueReminders` runs on each worker tick and moves reminders whose
 *      time has come into the outbox.
 *
 * The split is what makes a provider outage survivable: a failed send leaves a
 * reminder in the outbox with a backoff, while the plan itself is untouched and
 * cannot drift.
 */

import {
  addMinutes,
  formatDate,
  formatTime,
  planConfirmation,
  planReminders,
  renderTemplate,
  toIso,
  type Appointment,
  type Language,
  type Reminder,
  type ReminderPolicy,
} from '@mediflow/shared';

import type { TenantHandle } from '../db/tenant.js';
import { toAppointment, type Row } from '../db/mappers.js';
import { readSettings } from './settings.js';
import { queueOutbound } from './outbox.js';

export interface ScheduleResult {
  planned: number;
  skipped: number;
  cancelled: number;
}

/** The shared planner's policy, built from the clinic's stored settings. */
export function reminderPolicyFor(db: TenantHandle['db'], clinicId: string): ReminderPolicy {
  const settings = readSettings(db, clinicId);
  return {
    enabled: settings.reminders.enabled,
    defaultOffsetsMinutes: settings.reminders.defaultOffsetsMinutes,
    chronicExtraOffsetsMinutes: settings.reminders.chronicExtraOffsetsMinutes,
    channels: settings.reminders.channels,
    template: 'appointment_reminder',
    quietHours: settings.reminders.quietHours,
    minLeadMinutes: settings.reminders.minLeadMinutes,
    paused: !settings.reminders.enabled,
  };
}

/** A patient is treated as chronic for reminder purposes if either holds. */
function isChronicPatient(tenant: TenantHandle, patientId: string | null): boolean {
  if (!patientId) return false;
  const patient = tenant.get<Row>('patients', patientId);
  if (!patient) return false;
  const conditions = String(patient['chronic_conditions'] ?? '').trim();
  if (conditions !== '' && conditions !== '[]') return true;
  return tenant.count('follow_ups', "patient_id = ? AND status = 'active'", [patientId]) > 0;
}

/**
 * (Re)plan the reminders for one appointment.
 *
 * Pending rows are cancelled first, so rescheduling does not leave the old send
 * times queued - a patient would otherwise be reminded about a time they are no
 * longer attending.
 */
export function scheduleAppointmentReminders(
  tenant: TenantHandle,
  clinicId: string,
  appointmentId: string,
  options: { now?: string; forceChronic?: boolean } = {},
): ScheduleResult {
  const now = options.now ?? new Date().toISOString();
  const row = tenant.get<Row>('appointments', appointmentId);
  if (!row) return { planned: 0, skipped: 0, cancelled: 0 };

  const appointment: Appointment = toAppointment(row);
  const cancelled = cancelPendingReminders(tenant, appointmentId, now);

  const plan = planReminders({
    appointment,
    policy: reminderPolicyFor(tenant.db, clinicId),
    clinicId,
    chronic: options.forceChronic ?? isChronicPatient(tenant, appointment.patientId),
    now,
  });

  for (const reminder of plan.reminders) {
    tenant.insert('reminders', reminderRow(clinicId, reminder, now));
  }

  return { planned: plan.reminders.length, skipped: plan.skipped.length, cancelled };
}

/** Cancel not-yet-sent reminders. Sent ones stay for the audit trail. */
export function cancelPendingReminders(tenant: TenantHandle, appointmentId: string, now: string): number {
  const pending = tenant.all<Row>('reminders', "appointment_id = ? AND status = 'scheduled'", [appointmentId]);
  for (const reminder of pending) {
    tenant.update('reminders', String(reminder['id']), { status: 'cancelled', updated_at: now });
  }
  return pending.length;
}

function reminderRow(
  clinicId: string,
  reminder: Reminder,
  now: string,
): Record<string, string | number | null> {
  return {
    id: reminder.id,
    clinic_id: clinicId,
    appointment_id: reminder.appointmentId,
    patient_id: reminder.patientId,
    channel: reminder.channel,
    template: reminder.template,
    scheduled_for: reminder.scheduledFor,
    sent_at: null,
    status: reminder.status,
    offset_minutes: reminder.offsetMinutes,
    origin: reminder.origin,
    payload: JSON.stringify(reminder.payload),
    attempts: 0,
    last_error: null,
    message_id: null,
    created_at: now,
    updated_at: now,
  };
}

/**
 * Confirmation message for a new booking.
 *
 * Queued at offset 0 through the outbox rather than sent inline, so it obeys the
 * same consent and retry rules as every other message.
 */
export function queueBookingConfirmation(
  tenant: TenantHandle,
  clinicId: string,
  appointment: Appointment,
  now = new Date().toISOString(),
): boolean {
  const reminder = planConfirmation(appointment, clinicId, now);
  tenant.insert('reminders', reminderRow(clinicId, reminder, now));
  return dispatch(tenant, clinicId, reminder, now);
}

/**
 * How long a claimed reminder stays claimed.
 *
 * The claim writes `updated_at` rather than flipping the row to a new status:
 * `sending` is not a `ReminderStatus`, so a process that died between the claim
 * and the dispatch would leave a row the enum cannot explain and no reaper would
 * ever revisit. With a lease the row stays `scheduled`, and once the lease
 * expires any worker can pick it up again - a crash costs a duplicate attempt at
 * worst, never a silently dropped reminder.
 */
const CLAIM_LEASE_MINUTES = 5;

/**
 * Move due reminders into the outbox.
 *
 * The claim is a conditional `UPDATE ... WHERE updated_at <= cutoff`, so
 * whichever worker commits first wins and the loser sees zero changes. Two
 * workers on the same tick cannot enqueue the same reminder twice.
 */
export function queueDueReminders(tenant: TenantHandle, clinicId: string, now = new Date().toISOString()): number {
  const cutoff = toIso(addMinutes(new Date(now), -CLAIM_LEASE_MINUTES));

  const due = tenant.page<Row>('reminders', {
    where: "status = 'scheduled' AND scheduled_for <= ? AND (updated_at IS NULL OR updated_at <= ?)",
    params: [now, cutoff],
    orderBy: 'scheduled_for ASC',
    limit: 200,
    offset: 0,
  });

  const claim = tenant.db.prepare(
    "UPDATE reminders SET updated_at = ? WHERE id = ? AND clinic_id = ? AND status = 'scheduled' AND (updated_at IS NULL OR updated_at <= ?)",
  );

  let dispatched = 0;
  for (const row of due) {
    const id = String(row['id']);
    if (claim.run(now, id, clinicId, cutoff).changes === 0) continue;

    const reminder: Reminder = {
      id,
      clinicId,
      appointmentId: String(row['appointment_id']),
      patientId: String(row['patient_id']),
      channel: String(row['channel']) as Reminder['channel'],
      template: String(row['template']) as Reminder['template'],
      scheduledFor: String(row['scheduled_for']),
      sentAt: null,
      status: 'scheduled',
      offsetMinutes: Number(row['offset_minutes']),
      origin: String(row['origin']) as Reminder['origin'],
      payload: parsePayload(row['payload']),
      attempts: Number(row['attempts'] ?? 0),
      lastError: null,
      messageId: null,
      createdAt: String(row['created_at']),
      updatedAt: String(row['updated_at']),
    };

    if (dispatch(tenant, clinicId, reminder, now)) dispatched += 1;
  }
  return dispatched;
}

function parsePayload(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string' || value === '') return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Render a reminder and hand it to the outbox.
 *
 * Returns false when the reminder was skipped; the row records why either way.
 * A reminder is marked `sent` once the message is *queued*, not once delivered -
 * delivery is the worker's problem, and conflating them would make a provider
 * outage look like a reminder that was never attempted.
 */
function dispatch(tenant: TenantHandle, clinicId: string, reminder: Reminder, now: string): boolean {
  const patient = tenant.get<Row>('patients', reminder.patientId);
  if (!patient) {
    finish(tenant, reminder, 'skipped', now, 'Patient no longer exists.');
    return false;
  }

  const phone = (patient['whatsapp_number'] ?? patient['phone']) as string | null;
  if (!phone) {
    finish(tenant, reminder, 'skipped', now, 'No contactable number on file.');
    return false;
  }

  // Consent is checked before queueing, not after: queueing a message that must
  // never be sent puts it in the outbox where a later policy change could send
  // it. The worker re-checks at send time as a second line of defence.
  if (!Number(patient['whatsapp_opt_in'])) {
    finish(tenant, reminder, 'skipped', now, 'Patient has not opted in to WhatsApp messages.');
    return false;
  }

  const language: Language = String(patient['preferred_language'] ?? 'en') === 'ar' ? 'ar' : 'en';
  const appointment = tenant.get<Row>('appointments', reminder.appointmentId);
  const clinic = tenant.db.prepare('SELECT name, name_ar FROM clinics WHERE id = ?').get(clinicId) as
    | { name: string; name_ar: string | null }
    | undefined;

  // The appointment templates take `date` and `time` as separate placeholders,
  // formatted in the *clinic's* timezone and the patient's language. Feeding a
  // single pre-joined `startsAt` string would leave both required variables
  // blank, and every reminder would fail to render.
  const startsAt = appointment ? String(appointment['starts_at'] ?? '') : '';
  const timeZone = appointment ? String(appointment['timezone'] ?? 'UTC') : 'UTC';
  const locale = language === 'ar' ? 'ar-SA' : 'en-GB';

  const rendered = renderTemplate(reminder.template, language, {
    patientName: String(patient['full_name'] ?? ''),
    patientFirstName: String(patient['first_name'] ?? ''),
    clinicName: language === 'ar' ? (clinic?.name_ar ?? clinic?.name ?? '') : (clinic?.name ?? ''),
    startsAt: startsAt ? formatClinicLocal(startsAt, timeZone, language) : '',
    date: startsAt ? formatDate(startsAt, timeZone, locale) : '',
    time: startsAt ? formatTime(startsAt, timeZone, locale) : '',
    visitType: String(reminder.payload['visitType'] ?? 'consultation'),
    doctorName: appointment ? String(appointment['doctor_name'] ?? '') : '',
  });

  if (!rendered.ok) {
    // A missing variable is a data problem, not a transient one. Retrying it
    // would put the same failure in front of the patient five times.
    finish(tenant, reminder, 'failed', now, `Template variables missing: ${rendered.missing.join(', ')}`);
    return false;
  }

  const result = queueOutbound(tenant, {
    to: String(phone),
    body: rendered.body,
    template: reminder.template,
    patientId: reminder.patientId,
    appointmentId: reminder.appointmentId,
    // One message per reminder row, forever. This is what makes a replayed
    // worker tick safe even if the claim is lost.
    dedupeKey: `reminder:${reminder.id}`,
    correlationId: reminder.appointmentId,
    now,
  });

  if (!result.enqueued) {
    finish(tenant, reminder, 'skipped', now, 'A message for this reminder already exists.');
    return false;
  }

  tenant.update('reminders', reminder.id, {
    status: 'sent',
    sent_at: now,
    attempts: reminder.attempts + 1,
    message_id: result.row['id'] ? String(result.row['id']) : null,
    last_error: null,
    updated_at: now,
  });
  return true;
}

function finish(
  tenant: TenantHandle,
  reminder: Reminder,
  status: 'skipped' | 'failed' | 'cancelled',
  now: string,
  reason: string,
): void {
  tenant.update('reminders', reminder.id, {
    status,
    last_error: reason.slice(0, 300),
    updated_at: now,
  });
}

/**
 * Format an appointment time in the clinic's own timezone.
 *
 * The patient is told a time they can act on; `toLocaleString` on a UTC
 * instant would print the wrong clock time for any clinic outside UTC.
 */
function formatClinicLocal(startsAt: unknown, rowTimezone: unknown, language: Language): string {
  const instant = Date.parse(String(startsAt));
  if (Number.isNaN(instant)) return '';
  const timeZone = String(rowTimezone ?? '') || 'UTC';
  try {
    return new Intl.DateTimeFormat(language === 'ar' ? 'ar' : 'en-GB', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone,
    }).format(new Date(instant));
  } catch {
    // An invalid stored timezone must not stop a reminder going out.
    return new Date(instant).toISOString();
  }
}
