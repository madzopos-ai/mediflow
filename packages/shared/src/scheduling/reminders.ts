/**
 * Appointment reminder automation.
 *
 * A reminder is only useful if it arrives at a sensible hour, so the two rules
 * that matter are:
 *   - offsets are measured backwards from the appointment start;
 *   - a reminder that would land inside quiet hours, or so close to the
 *     appointment it is noise, is moved or dropped rather than sent.
 *
 * Moving rather than dropping is deliberate: a 22:00 reminder for a 09:00
 * appointment is pushed to the quiet-hours boundary that morning, because the
 * patient still needs to know.
 */

import type { Appointment, Reminder, ReminderPolicy } from '../domain/types.js';
import type { ReminderChannel, ReminderTemplate } from '../domain/enums.js';
import { addMinutes, addDaysToDateKey, dateKeyInTz, minutesBetween, toIso, zonedParts, zonedTimeToUtc } from '../core/time.js';
import { createId } from '../core/ids.js';

export interface PlanReminderInput {
  appointment: Appointment;
  policy: ReminderPolicy;
  clinicId: string;
  /** Adds the chronic-patient extra offsets. */
  chronic?: boolean;
  /** Overrides the policy template. */
  template?: ReminderTemplate;
  channels?: readonly ReminderChannel[];
  now?: string;
}

export type ReminderSkip =
  | 'policy_paused'
  | 'policy_disabled'
  | 'appointment_cancelled'
  | 'appointment_past'
  | 'inside_quiet_hours'
  | 'too_close'
  | 'no_contactable_number';

export interface ReminderPlan {
  reminders: Reminder[];
  skipped: { offsetMinutes: number; reason: ReminderSkip }[];
}

/**
 * Quiet hours wrap past midnight (e.g. 22:00-07:00), so membership is checked
 * with two ranges rather than a single comparison.
 */
export function isInsideQuietHours(instant: string, quiet: { startHour: number; endHour: number }, timeZone: string): boolean {
  const hour = zonedParts(new Date(instant), timeZone).hour;
  const { startHour, endHour } = quiet;
  if (startHour === endHour) return false;
  if (startHour < endHour) return hour >= startHour && hour < endHour;
  return hour >= startHour || hour < endHour;
}

/**
 * The next moment at or after `instant` that is outside quiet hours.
 *
 * The boundary is resolved in clinic-local time and then converted, not by
 * setting the hour on the UTC instant: for a UTC+3 clinic, "quiet ends at
 * 07:00" is 04:00 UTC, and using the UTC hour released every quiet-hours
 * message three hours late.
 */
export function pushOutOfQuietHours(
  instant: string,
  quiet: { startHour: number; endHour: number },
  timeZone: string,
): string {
  if (!isInsideQuietHours(instant, quiet, timeZone)) return instant;

  const at = new Date(instant);
  let dateKey = dateKeyInTz(at, timeZone);
  let boundary = zonedTimeToUtc(dateKey, `${String(quiet.endHour).padStart(2, '0')}:00`, timeZone);
  if (boundary.getTime() <= at.getTime()) {
    // Quiet hours wrapped past midnight, so the end is on the following day.
    dateKey = addDaysToDateKey(dateKey, 1);
    boundary = zonedTimeToUtc(dateKey, `${String(quiet.endHour).padStart(2, '0')}:00`, timeZone);
  }
  return toIso(boundary);
}

export function planReminders(input: PlanReminderInput): ReminderPlan {
  const now = input.now ?? new Date().toISOString();
  const { appointment, policy, clinicId } = input;
  const reminders: Reminder[] = [];
  const skipped: ReminderPlan['skipped'] = [];

  if (policy.paused) {
    return { reminders, skipped: policy.defaultOffsetsMinutes.map((o) => ({ offsetMinutes: o, reason: 'policy_paused' as const })) };
  }
  if (!policy.enabled) {
    return { reminders, skipped: policy.defaultOffsetsMinutes.map((o) => ({ offsetMinutes: o, reason: 'policy_disabled' as const })) };
  }
  if (appointment.status === 'cancelled' || appointment.status === 'no_show' || appointment.status === 'rescheduled') {
    return { reminders, skipped: policy.defaultOffsetsMinutes.map((o) => ({ offsetMinutes: o, reason: 'appointment_cancelled' as const })) };
  }
  if (!appointment.patientPhone) {
    return { reminders, skipped: policy.defaultOffsetsMinutes.map((o) => ({ offsetMinutes: o, reason: 'no_contactable_number' as const })) };
  }

  const start = new Date(appointment.startsAt);
  if (start.getTime() <= new Date(now).getTime()) {
    return { reminders, skipped: policy.defaultOffsetsMinutes.map((o) => ({ offsetMinutes: o, reason: 'appointment_past' as const })) };
  }

  const offsets = [...new Set([...policy.defaultOffsetsMinutes, ...(input.chronic ? policy.chronicExtraOffsetsMinutes : [])])]
    .filter((o) => Number.isFinite(o) && o >= 0)
    .sort((a, b) => b - a);

  const channels = input.channels ?? policy.channels;
  const template = input.template ?? policy.template;

  for (const offset of offsets) {
    let scheduledFor = toIso(addMinutes(start, -offset));

    if (offset < policy.minLeadMinutes) {
      skipped.push({ offsetMinutes: offset, reason: 'too_close' });
      continue;
    }
    if (scheduledFor <= now) {
      // The window has already passed; do not fire a "reminder" late.
      skipped.push({ offsetMinutes: offset, reason: 'appointment_past' });
      continue;
    }

    const pushed = pushOutOfQuietHours(scheduledFor, policy.quietHours, appointment.timezone);
    if (pushed !== scheduledFor) {
      const stillBeforeStart = minutesBetween(new Date(pushed), start) >= policy.minLeadMinutes;
      if (!stillBeforeStart) {
        skipped.push({ offsetMinutes: offset, reason: 'inside_quiet_hours' });
        continue;
      }
      scheduledFor = pushed;
    }

    for (const channel of channels.length > 0 ? channels : (['whatsapp'] as ReminderChannel[])) {
      reminders.push({
        id: createId('rem'),
        clinicId,
        appointmentId: appointment.id,
        patientId: appointment.patientId,
        channel,
        template,
        scheduledFor,
        sentAt: null,
        status: 'scheduled',
        offsetMinutes: offset,
        origin: input.chronic ? 'patient' : 'global',
        payload: { startsAt: appointment.startsAt, visitType: appointment.visitType },
        attempts: 0,
        lastError: null,
        messageId: null,
        createdAt: now,
        updatedAt: now,
      });
    }
  }

  reminders.sort((a, b) => a.scheduledFor.localeCompare(b.scheduledFor));
  return { reminders, skipped };
}

/** Cancel outstanding reminders when an appointment is cancelled or moved. */
export function cancelReminders(
  reminders: readonly Reminder[],
  reason: 'appointment_cancelled' | 'appointment_rescheduled',
  now: string = new Date().toISOString(),
): Reminder[] {
  return reminders
    .filter((r) => r.status === 'scheduled')
    .map((r) => ({
      ...r,
      status: 'cancelled' as const,
      origin: 'auto_cancelled' as const,
      lastError: reason,
      updatedAt: now,
    }));
}

/** The confirmation message a new booking should trigger immediately. */
export function planConfirmation(appointment: Appointment, clinicId: string, now?: string): Reminder {
  return {
    id: createId('rem'),
    clinicId,
    appointmentId: appointment.id,
    patientId: appointment.patientId,
    channel: 'whatsapp',
    template: 'appointment_confirm',
    scheduledFor: now ?? new Date().toISOString(),
    sentAt: null,
    status: 'scheduled',
    offsetMinutes: 0,
    origin: 'global',
    payload: { startsAt: appointment.startsAt, visitType: appointment.visitType },
    attempts: 0,
    lastError: null,
    messageId: null,
    createdAt: now ?? new Date().toISOString(),
    updatedAt: now ?? new Date().toISOString(),
  };
}

/** Reminders due to be sent right now. */
export function dueReminders(reminders: readonly Reminder[], now: string = new Date().toISOString()): Reminder[] {
  return reminders.filter((r) => r.status === 'scheduled' && r.scheduledFor <= now);
}

export interface ReminderStats {
  scheduled: number;
  sent: number;
  failed: number;
  cancelled: number;
  skipped: number;
}

export function summariseReminders(reminders: readonly Reminder[]): ReminderStats {
  const stats: ReminderStats = { scheduled: 0, sent: 0, failed: 0, cancelled: 0, skipped: 0 };
  for (const reminder of reminders) stats[reminder.status] += 1;
  return stats;
}
