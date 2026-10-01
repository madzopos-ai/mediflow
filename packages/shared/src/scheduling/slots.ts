/**
 * Slot generation and availability.
 *
 * Time handling is the whole difficulty here, and it is where scheduling bugs
 * cause real harm: a clinic in Riyadh that books a 09:00 slot as 06:00 UTC will
 * see patients arrive at 06:00.
 *
 * The rules this module enforces:
 *   - Working hours, breaks, holidays and blocked windows are all subtracted
 *     in the clinic's local time, then converted to UTC once at the end.
 *   - Slots are laid on a fixed `slotIntervalMinutes` grid anchored to the
 *     working-hours start, not to "now", so the grid does not drift and two
 *     clinics with the same hours publish the same slots.
 *   - `bufferMinutes` after an appointment is treated as occupied time, so a
 *     30-minute consultation with a 10-minute buffer cannot be back-to-back
 *     booked against a slot that starts 30 minutes later.
 *   - Statuses that free a slot (cancelled, no_show, rescheduled) are excluded
 *     from the busy set; a held public booking is not.
 *
 * All functions are pure.
 */

import type { Appointment, ClinicSchedule, WorkingHours } from '../domain/types.js';
import {
  addDays,
  addDaysToDateKey,
  dateKeyInTz,
  parseTimeToMinutes,
  weekdayOfDateKey,
  zonedTimeToUtc,
  toIso,
} from '../core/time.js';

/** Statuses that no longer occupy the calendar. */
export const SLOT_FREEING_STATUSES = new Set(['cancelled', 'no_show', 'rescheduled']);

export interface Slot {
  /** UTC instant. */
  startsAt: string;
  endsAt: string;
  /** Clinic-local date key, handy for grouping in the UI. */
  dateKey: string;
  /** Clinic-local "HH:mm", the label patients see. */
  localStart: string;
  localEnd: string;
  durationMinutes: number;
}

export interface GenerateSlotsOptions {
  schedule: ClinicSchedule;
  /** Clinic IANA timezone. */
  timeZone: string;
  /** Local date key (yyyy-mm-dd). */
  dateKey: string;
  /** Overrides the schedule's own interval (e.g. a longer visit type). */
  durationMinutes?: number;
  /** Extra buffer for a specific doctor or procedure. */
  extraBufferMinutes?: number;
  /** Only these visit types are considered, when filtering later. */
  earliestUtc?: string;
  latestUtc?: string;
}

function workingHoursFor(schedule: ClinicSchedule, dateKey: string): WorkingHours | undefined {
  const weekday = weekdayOfDateKey(dateKey);
  return schedule.workingHours.find((w) => w.weekday === weekday && w.enabled);
}

export type SlotRejection =
  | 'clinic_closed'
  | 'holiday'
  | 'blocked_window'
  | 'daily_limit_reached'
  | 'outside_booking_window'
  | 'no_contactable_time';

/** Why a date has no bookable slots at all. */
export function explainEmptyDay(
  schedule: ClinicSchedule,
  timeZone: string,
  dateKey: string,
  now: string = new Date().toISOString(),
  booking: { minNoticeHours: number; maxAdvanceDays: number } = { minNoticeHours: 0, maxAdvanceDays: 365 },
): SlotRejection | null {
  if (schedule.holidays.some((h) => h.date === dateKey)) return 'holiday';
  const hours = workingHoursFor(schedule, dateKey);
  if (!hours) return 'clinic_closed';
  if (schedule.blockedWindows.some((b) => b.date === dateKey)) return 'blocked_window';

  const maxDate = toIso(addDays(new Date(now), booking.maxAdvanceDays));
  const endOfDay = zonedTimeToUtc(dateKey, hours.end, timeZone);
  if (endOfDay.getTime() > new Date(maxDate).getTime()) return 'outside_booking_window';

  const earliest = new Date(new Date(now).getTime() + booking.minNoticeHours * 3_600_000);
  const startOfDay = zonedTimeToUtc(dateKey, hours.start, timeZone);
  if (endOfDay.getTime() < earliest.getTime()) return 'no_contactable_time';

  if (startOfDay.getTime() > earliest.getTime() && endOfDay.getTime() < earliest.getTime()) {
    return 'no_contactable_time';
  }
  return null;
}

interface MinuteWindow {
  start: number;
  end: number;
}

/** Merge overlapping windows so a long break is not double-subtracted. */
function normaliseWindows(windows: readonly MinuteWindow[]): MinuteWindow[] {
  const sorted = windows
    .filter((w) => w.end > w.start)
    .slice()
    .sort((a, b) => a.start - b.start);
  const merged: MinuteWindow[] = [];
  for (const window of sorted) {
    const last = merged[merged.length - 1];
    if (last && window.start <= last.end) {
      last.end = Math.max(last.end, window.end);
    } else {
      merged.push({ start: window.start, end: window.end });
    }
  }
  return merged;
}

function subtract(base: MinuteWindow[], holes: readonly MinuteWindow[]): MinuteWindow[] {
  let current = base;
  for (const hole of normaliseWindows(holes)) {
    const next: MinuteWindow[] = [];
    for (const window of current) {
      if (hole.end <= window.start || hole.start >= window.end) {
        next.push(window);
        continue;
      }
      if (hole.start > window.start) next.push({ start: window.start, end: hole.start });
      if (hole.end < window.end) next.push({ start: hole.end, end: window.end });
    }
    current = next;
  }
  return current;
}

/**
 * Every bookable slot on a local date, before existing appointments are applied.
 *
 * Returns an empty array for a closed day or holiday; use `explainEmptyDay`
 * when the UI needs to say why.
 */
export function generateSlots(options: GenerateSlotsOptions): Slot[] {
  const { schedule, timeZone, dateKey } = options;
  const hours = workingHoursFor(schedule, dateKey);
  if (!hours) return [];
  if (schedule.holidays.some((h) => h.date === dateKey)) return [];

  const openStart = parseTimeToMinutes(hours.start);
  const openEnd = parseTimeToMinutes(hours.end);
  if (openStart === null || openEnd === null || openEnd <= openStart) return [];

  const duration = options.durationMinutes ?? schedule.slotDurationMinutes;
  if (duration <= 0) return [];
  const interval = Math.max(duration, schedule.slotIntervalMinutes || duration);

  const holes: MinuteWindow[] = [];
  for (const breakWindow of hours.breaks ?? []) {
    const start = parseTimeToMinutes(breakWindow.start);
    const end = parseTimeToMinutes(breakWindow.end);
    if (start !== null && end !== null) holes.push({ start, end });
  }
  for (const blocked of schedule.blockedWindows) {
    if (blocked.date !== dateKey) continue;
    const start = parseTimeToMinutes(blocked.start);
    const end = parseTimeToMinutes(blocked.end);
    if (start !== null && end !== null) holes.push({ start, end });
  }

  const windows = subtract([{ start: openStart, end: openEnd }], holes);
  const slots: Slot[] = [];

  for (const window of windows) {
    // Anchor the grid to the start of the open window so breaks do not shift
    // the published times: a 09:00-12:00 and 13:00-17:00 day publishes 09:00,
    // 09:30, ... 11:30 then 13:00, 13:30, ... 16:30.
    for (let minute = window.start; minute + duration <= window.end; minute += interval) {
      const startUtc = zonedTimeToUtc(dateKey, minutesToTimeLocal(minute), timeZone);
      const endUtc = zonedTimeToUtc(dateKey, minutesToTimeLocal(minute + duration), timeZone);
      const startsAt = toIso(startUtc);
      const endsAt = toIso(endUtc);
      if (options.earliestUtc && startsAt < options.earliestUtc) continue;
      if (options.latestUtc && startsAt > options.latestUtc) continue;
      slots.push({
        startsAt,
        endsAt,
        dateKey,
        localStart: minutesToTimeLocal(minute),
        localEnd: minutesToTimeLocal(minute + duration),
        durationMinutes: duration,
      });
    }
  }

  slots.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  return slots;
}

function minutesToTimeLocal(minutes: number): string {
  const h = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** Appointment status that still holds the calendar. */
export function occupiesSlot(appointment: Appointment, now: string = new Date().toISOString()): boolean {
  if (SLOT_FREEING_STATUSES.has(appointment.status)) return false;
  // An expired hold no longer holds the slot.
  if (appointment.holdExpiresAt !== null && appointment.holdExpiresAt <= now) return false;
  return true;
}

export interface AvailabilityInput {
  schedule: ClinicSchedule;
  timeZone: string;
  appointments: readonly Appointment[];
  durationMinutes?: number;
  extraBufferMinutes?: number;
  now?: string;
  doctorId?: string | null;
}

/**
 * Free slots across a date range, with existing appointments and their buffers
 * removed.
 *
 * The buffer is applied to both sides of an existing appointment, so a
 * candidate slot overlapping the trailing buffer is rejected. A clinic that
 * forgets this ends up running ten minutes late for the whole day.
 */
export function findAvailableSlots(input: AvailabilityInput, fromDateKey: string, toDateKey: string): Slot[] {
  const now = input.now ?? new Date().toISOString();
  const buffer = (input.schedule.bufferMinutes ?? 0) + (input.extraBufferMinutes ?? 0);
  const duration = input.durationMinutes ?? input.schedule.slotDurationMinutes;

  const busy = input.appointments
    .filter((a) => occupiesSlot(a, now))
    .filter((a) => (input.doctorId ? a.doctorId === input.doctorId : true))
    .map((a) => ({
      start: new Date(a.startsAt).getTime() - buffer * 60_000,
      end: new Date(a.endsAt).getTime() + buffer * 60_000,
    }))
    .sort((a, b) => a.start - b.start);

  const slots: Slot[] = [];
  let cursor = fromDateKey;
  // Guard against a caller passing a reversed range and looping for ever.
  let guard = 0;
  while (cursor <= toDateKey && guard < 400) {
    guard += 1;
    const daySlots = generateSlots({
      schedule: input.schedule,
      timeZone: input.timeZone,
      dateKey: cursor,
      durationMinutes: duration,
      earliestUtc: now,
    });

    for (const slot of daySlots) {
      const start = new Date(slot.startsAt).getTime();
      const end = new Date(slot.endsAt).getTime();
      const conflict = busy.some((b) => start < b.end && end > b.start);
      if (!conflict) slots.push(slot);
    }
    cursor = addDaysToDateKey(cursor, 1);
  }
  return slots;
}

/** True when a specific instant range is still free. */
export function isRangeFree(
  startsAt: string,
  endsAt: string,
  appointments: readonly Appointment[],
  options: { bufferMinutes?: number; now?: string; ignoreAppointmentId?: string } = {},
): boolean {
  const now = options.now ?? new Date().toISOString();
  const buffer = (options.bufferMinutes ?? 0) * 60_000;
  const start = new Date(startsAt).getTime();
  const end = new Date(endsAt).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return false;

  return !appointments
    .filter((a) => a.id !== options.ignoreAppointmentId)
    .filter((a) => occupiesSlot(a, now))
    .some((a) => {
      const bStart = new Date(a.startsAt).getTime() - buffer;
      const bEnd = new Date(a.endsAt).getTime() + buffer;
      return start < bEnd && end > bStart;
    });
}

export type BookingBlock =
  | 'closed_day'
  | 'holiday'
  | 'blocked_window'
  | 'outside_working_hours'
  | 'min_notice'
  | 'too_far_ahead'
  | 'slot_taken'
  | 'max_daily'
  | 'invalid_range';

export interface BookingAttempt {
  startsAt: string;
  endsAt?: string;
  durationMinutes?: number;
  doctorId?: string | null;
  isPublicBooking?: boolean;
}

/**
 * Validate a booking request before writing anything.
 *
 * Reports a single specific reason so the caller can show the patient something
 * actionable instead of "booking failed".
 */
export function validateBooking(
  attempt: BookingAttempt,
  input: AvailabilityInput & { booking: { minNoticeHours: number; maxAdvanceDays: number; maxDailyAppointments: number | null } },
): { ok: true; endsAt: string } | { ok: false; reason: BookingBlock } {
  const now = input.now ?? new Date().toISOString();
  const start = new Date(attempt.startsAt);
  if (Number.isNaN(start.getTime())) return { ok: false, reason: 'invalid_range' };

  const duration = attempt.durationMinutes ?? input.schedule.slotDurationMinutes;
  const endsAt = attempt.endsAt ?? toIso(new Date(start.getTime() + duration * 60_000));
  if (new Date(endsAt).getTime() <= start.getTime()) return { ok: false, reason: 'invalid_range' };

  const timeZone = input.timeZone;
  const dateKey = dateKeyInTz(start, timeZone);
  const localStartMinutes = parseTimeToMinutes(localTimeInTz(start, timeZone));
  const localEndMinutes = parseTimeToMinutes(localTimeInTz(new Date(endsAt), timeZone));
  if (localStartMinutes === null || localEndMinutes === null) {
    return { ok: false, reason: 'invalid_range' };
  }

  if (input.booking.minNoticeHours > 0) {
    const earliest = new Date(new Date(now).getTime() + input.booking.minNoticeHours * 3_600_000);
    if (start.getTime() < earliest.getTime()) return { ok: false, reason: 'min_notice' };
  }
  const maxDate = addDays(new Date(now), input.booking.maxAdvanceDays);
  if (dateKeyInTz(maxDate, timeZone) < dateKey) return { ok: false, reason: 'too_far_ahead' };

  if (input.schedule.holidays.some((h) => h.date === dateKey)) return { ok: false, reason: 'holiday' };

  const hours = workingHoursFor(input.schedule, dateKey);
  if (!hours) return { ok: false, reason: 'closed_day' };

  const openStart = parseTimeToMinutes(hours.start);
  const openEnd = parseTimeToMinutes(hours.end);
  if (openStart === null || openEnd === null) return { ok: false, reason: 'closed_day' };
  if (localStartMinutes < openStart || localEndMinutes > openEnd) {
    return { ok: false, reason: 'outside_working_hours' };
  }
  // A booking must not sit inside a break or blocked window.
  const inBreak = (hours.breaks ?? []).some((b) => {
    const bs = parseTimeToMinutes(b.start);
    const be = parseTimeToMinutes(b.end);
    return bs !== null && be !== null && localStartMinutes < be && localEndMinutes > bs;
  });
  if (inBreak) return { ok: false, reason: 'blocked_window' };
  const inBlocked = input.schedule.blockedWindows.some((b) => {
    if (b.date !== dateKey) return false;
    const bs = parseTimeToMinutes(b.start);
    const be = parseTimeToMinutes(b.end);
    return bs !== null && be !== null && localStartMinutes < be && localEndMinutes > be;
  });
  if (inBlocked) return { ok: false, reason: 'blocked_window' };

  const relevant = input.appointments.filter((a) => (attempt.doctorId ? a.doctorId === attempt.doctorId : true));
  if (
    input.booking.maxDailyAppointments !== null &&
    relevant.filter((a) => dateKeyInTz(new Date(a.startsAt), timeZone) === dateKey && occupiesSlot(a, now)).length >=
      input.booking.maxDailyAppointments
  ) {
    return { ok: false, reason: 'max_daily' };
  }

  const free = isRangeFree(attempt.startsAt, endsAt, input.appointments, {
    bufferMinutes: (input.schedule.bufferMinutes ?? 0) + (input.extraBufferMinutes ?? 0),
    now,
  });
  if (!free) {
    // A hold that is still live reports "slot taken" rather than a raw clash,
    // which is what a patient needs to hear.
    return { ok: false, reason: 'slot_taken' };
  }
  return { ok: true, endsAt };
}

function localTimeInTz(instant: Date, timeZone: string): string {
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
