/**
 * WhatsApp booking over chat: intent -> proposal -> patient yes/no -> draft.
 *
 * A patient writes "بدي احجز بكرة الساعة ٥" and the system walks them to a
 * real appointment, with a human confirming at the end. Two rules shape every
 * line below:
 *
 * 1. Never guess. A bare "٥" is morning or evening, and booking the wrong one
 *    wastes a patient's trip. Anything ambiguous is asked back, in the
 *    patient's own idiom ("٥ الصبح ولا المسا؟").
 * 2. The bot proposes, the staff disposes. A "yes" creates a `pending`
 *    appointment that blocks the slot but sends nothing; confirmation,
 *    reminders and any apology only ever come from the staff confirm action.
 *    Auto-booking from free text would be a chaos generator in a clinic.
 *
 * Conversation state is one row per phone number (`wa_booking_state`), so a
 * "yes" only ever confirms the proposal that preceded it, and a row older
 * than a day is treated as expired - a stale "yes" can never confirm last
 * week's slot.
 */

import {
  addDaysToDateKey,
  dateKeyInTz,
  validateBooking,
  weekdayOfDateKey,
  zonedTimeToUtc,
} from '@mediflow/shared';

import { ApiError } from '../http/errors.js';
import type { Db } from '../db/index.js';
import type { TenantHandle } from '../db/tenant.js';
import { createId } from '@mediflow/shared';
import { availableSlots, bookingContextFor, createBooking, loadAppointmentsForRange } from './appointments.js';
import { queueOutbound } from './outbox.js';
import { createPatient } from './patients.js';
import { clinicTimezone } from './settings.js';

// ---------------------------------------------------------------------------
// Normalisation: Lebanese WhatsApp Arabic is not MSA and not consistent.
// Digits come Indic or ASCII, hamzas wander, words stretch for emphasis.
// Everything below matches against this normalised form - never the raw text.
// ---------------------------------------------------------------------------

const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩';
const FA_DIGITS = '۰۱۲۳۴۵۶۷۸۹';

export function normalizeArabic(text: string): string {
  let out = text;
  for (let i = 0; i < 10; i += 1) {
    out = out.split(AR_DIGITS[i] ?? '').join(String(i));
    out = out.split(FA_DIGITS[i] ?? '').join(String(i));
  }
  out = out
    .replace(/[أإآ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/ـ/g, '')
    .replace(/[ً-ٟ]/g, '')
    .replace(/(.)\1{2,}/g, '$1') // لاااا -> لا
    .toLowerCase();
  return out;
}

/** Whole-message match, tolerant of trailing punctuation. */
function says(text: string, ...forms: string[]): boolean {
  const clean = text.trim().replace(/[؟?!.,،\s]+$/g, '');
  return forms.includes(clean);
}

export function isYes(text: string): boolean {
  return says(text, 'نعم', 'اي', 'اه', 'أه', 'اكيد', 'تمام', 'اوكي', 'ماشي', 'صح', 'yes', 'y', 'ok', '1', 'اي نعم');
}

export function isNo(text: string): boolean {
  return says(text, 'لا', 'لأ', 'لاء', 'كلا', 'مش', 'بلا', 'ما بدي', 'مابدي', 'no', 'n', '0');
}

export function isCancel(text: string): boolean {
  return /(الغي|الغاء|بطلت|كنسل|cancel)/.test(text);
}

export function isBookingIntent(text: string): boolean {
  // NOTE: no bare "عياده" - "وين العيادة؟" is a location question, while real
  // bookings always carry a verb or موعد/حجز alongside it.
  return /(احجز|بحجز|حجز|موعد|ميعاد|booking|appointment|بدي (اجي|ايجي|زور)|عايز|فيي|ممكن)/.test(text);
}

// ---------------------------------------------------------------------------
// Dates: relative days and weekday names, resolved against clinic-local today.
// ---------------------------------------------------------------------------

const WEEKDAYS: { day: number; names: string[] }[] = [
  { day: 0, names: ['الاحد'] },
  { day: 1, names: ['الاثنين', 'التنين'] },
  { day: 2, names: ['الثلاثاء', 'التلاتا', 'التلاثا'] },
  { day: 3, names: ['الاربعاء', 'الاربعا'] },
  { day: 4, names: ['الخميس'] },
  { day: 5, names: ['الجمعه', 'الجمعة'] },
  { day: 6, names: ['السبت'] },
];

/** Resolves a date expression to a yyyy-mm-dd key, or null. */
export function parseDate(text: string, todayKey: string): string | null {
  if (/(اليوم|النهارده|النهارده|today)/.test(text)) return todayKey;
  if (/(بعد بكره|بعد بكرا|بعد بكرة|بعد غدا)/.test(text)) return addDaysToDateKey(todayKey, 2);
  if (/(بكره|بكرا|بكرة|غدا|tomorrow)/.test(text)) return addDaysToDateKey(todayKey, 1);
  const todayWeekday = weekdayOfDateKey(todayKey);
  for (const { day, names } of WEEKDAYS) {
    if (names.some((n) => text.includes(n))) {
      // The coming one: today if it matches, otherwise the next occurrence.
      // A same-day request whose time has passed fails availability later with
      // a concrete alternative, which beats guessing "did they mean next week".
      const delta = (day - todayWeekday + 7) % 7;
      return addDaysToDateKey(todayKey, delta);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Times: explicit hours parse, bare hours are ambiguous, markers disambiguate.
// ---------------------------------------------------------------------------

export type TimeParse = { kind: 'time'; minutes: number } | { kind: 'ambiguous'; hour: number } | { kind: 'none' };

const AM_MARKERS = /(صباحا|الصبح|صباح|am\b)/;
const PM_MARKERS = /(مساء|المسا|مسا|بعد الضهر|بعد الظهر|الضهر|الظهر|العصر|المغرب|بالليل|pm\b)/;

/** Parses a clock time out of normalised text. */
export function parseTime(text: string): TimeParse {
  // "الساعة ٥", "الساعه 5:30", "5:30", "17:00"
  const clock = text.match(/(?:الساعه|الساعة)?\s*(\d{1,2})(?:[:.](\d{2}))?/);
  let hour: number | null = null;
  let minute = 0;
  if (clock?.[1]) {
    hour = Number(clock[1]);
    // "الساعة ٥ ونص" / "5 وربع" / "5 الا ربع" (also after a clock match)
    if (/الا ربع/.test(text)) minute = -15;
    else if (/الا تلت/.test(text)) minute = -20;
    else if (/ونص|ونصف/.test(text)) minute = 30;
    else if (/وربع/.test(text)) minute = 15;
    if (clock[2]) minute = Number(clock[2]);
  } else if (/(ونص)/.test(text)) {
    // "ونص" alone carries no hour - ambiguous, not none.
    return { kind: 'none' };
  }
  if (hour === null || hour > 23 || minute > 59) return { kind: 'none' };

  if (minute < 0) {
    hour -= 1;
    minute += 60;
  }
  if (hour < 0 || hour > 23) return { kind: 'none' };

  const am = AM_MARKERS.test(text);
  const pm = PM_MARKERS.test(text);
  if (hour >= 13) return { kind: 'time', minutes: hour * 60 + minute };
  if (hour === 12) {
    // "الظهر"/"12" alone means noon; "12 بالليل" means midnight.
    if (/بالليل/.test(text)) return { kind: 'time', minutes: 0 + minute };
    return { kind: 'time', minutes: 12 * 60 + minute };
  }
  if (am && !pm) return { kind: 'time', minutes: hour * 60 + minute };
  if (pm && !am) return { kind: 'time', minutes: (hour + 12) * 60 + minute };
  if (am && pm) return { kind: 'none' }; // contradictory markers: ask, don't guess
  if (hour === 0) return { kind: 'time', minutes: minute };
  return { kind: 'ambiguous', hour };
}

/** Combines a stored ambiguous hour with a bare meridiem ("المسا" -> +12). */
export function withMeridiem(hour: number, text: string): number | null {
  if (hour < 1 || hour > 12) return null;
  const am = AM_MARKERS.test(text);
  const pm = PM_MARKERS.test(text);
  if (am && !pm) return hour === 12 ? 12 * 60 : hour * 60;
  if (pm && !am) return hour === 12 ? 12 * 60 : (hour + 12) * 60;
  return null;
}

/** Arabic display for minutes-since-midnight, e.g. 1050 -> "الساعة 5:30 المسا". */
export function formatTimeAr(minutes: number): string {
  const h24 = Math.floor(minutes / 60);
  const mm = minutes % 60;
  const period = h24 < 5 ? 'بالليل' : h24 < 12 ? 'الصبح' : h24 === 12 ? 'الظهر' : h24 < 18 ? 'بعد الظهر' : 'المسا';
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  const clock = mm === 0 ? `${h12}` : `${h12}:${String(mm).padStart(2, '0')}`;
  return `الساعة ${clock} ${period}`;
}

const AR_WEEKDAYS = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];

/** "الثلاثاء ٧/١٠" for a date key. */
export function formatDateAr(dateKey: string): string {
  const weekday = AR_WEEKDAYS[weekdayOfDateKey(dateKey)] ?? '';
  const [, m, d] = dateKey.split('-').map(Number);
  return `${weekday} ${d}/${m}`;
}

// ---------------------------------------------------------------------------
// Conversation flow.
// ---------------------------------------------------------------------------

export type BookingStep = 'awaiting_time' | 'awaiting_confirm';

interface BookingState {
  step: BookingStep;
  dateKey: string | null;
  /**
   * Meaning depends on the step. In `awaiting_confirm` it is the proposed
   * slot in minutes. In `awaiting_time` it is either null (nothing known) or
   * NEGATIVE (an ambiguous hour awaiting its meridiem: -5 means "٥" without
   * صبح/مسا, so a bare "المسا" completes it). Never a bare positive hour:
   * those are meaningless without a meridiem and must not be proposed.
   */
  timeMinutes: number | null;
  updatedAt: string;
}

export interface BookingOutcome {
  action: 'ignored' | 'asked_time' | 'asked_confirm' | 'booked_pending' | 'cancelled' | 'clarified' | 'closed_day' | 'busy_alt';
  reply: string | null;
}

const STATE_TTL_MS = 24 * 60 * 60_000;

function readState(db: Db, clinicId: string, phone: string, nowMs: number): BookingState | null {
  const row = db
    .prepare('SELECT step, date_key, time_minutes, updated_at FROM wa_booking_state WHERE clinic_id = ? AND phone = ?')
    .get(clinicId, phone) as
    | { step: string; date_key: string | null; time_minutes: number | null; updated_at: string }
    | undefined;
  if (!row) return null;
  if (nowMs - Date.parse(row.updated_at) > STATE_TTL_MS) {
    db.prepare('DELETE FROM wa_booking_state WHERE clinic_id = ? AND phone = ?').run(clinicId, phone);
    return null;
  }
  if (row.step !== 'awaiting_time' && row.step !== 'awaiting_confirm') return null;
  return { step: row.step, dateKey: row.date_key, timeMinutes: row.time_minutes, updatedAt: row.updated_at };
}

function writeState(db: Db, clinicId: string, phone: string, state: BookingState, now: string): void {
  db.prepare(
    `INSERT INTO wa_booking_state (id, clinic_id, phone, step, date_key, time_minutes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(clinic_id, phone) DO UPDATE SET step = excluded.step, date_key = excluded.date_key,
       time_minutes = excluded.time_minutes, updated_at = excluded.updated_at`,
  ).run(createId('wbs'), clinicId, phone, state.step, state.dateKey, state.timeMinutes, now, now);
}

function clearState(db: Db, clinicId: string, phone: string): void {
  db.prepare('DELETE FROM wa_booking_state WHERE clinic_id = ? AND phone = ?').run(clinicId, phone);
}

function digitsOf(phone: string): string {
  return phone.replace(/[^0-9]/g, '');
}

function matchPatient(tenant: TenantHandle, digits: string): { id: string } | undefined {
  if (digits.length < 7) return undefined;
  const tail = digits.slice(-8);
  // Suffix match: stored numbers are E.164 (+961...) while the sender may
  // arrive in any local format. Last-8-digits is stable for Lebanese mobiles.
  return tenant.db
    .prepare(
      `SELECT id FROM patients
        WHERE replace(replace(replace(COALESCE(whatsapp_number, phone), '+', ''), ' ', ''), '-', '') LIKE ?
        LIMIT 1`,
    )
    .get(`%${tail}`) as { id: string } | undefined;
}

function replyText(tenant: TenantHandle, phone: string, patientId: string | null, body: string): void {
  queueOutbound(tenant, { to: phone, body, template: 'custom', channel: 'whatsapp', patientId });
}

function confirmQuestion(dateKey: string, minutes: number): string {
  return `هل تريد تأكيد الحجز ${formatDateAr(dateKey)} ${formatTimeAr(minutes)}؟ رد بنعم أو لا.`;
}

/**
 * Handles one inbound patient message for the booking flow.
 *
 * Returns what happened and the reply to send (null = stay silent). Replies
 * are enqueued, never sent inline: the gateway picks them up on its next poll
 * like every other outbox row, so downtime just delays them.
 */
export function handleInboundBooking(
  db: Db,
  tenant: TenantHandle,
  clinicId: string,
  phone: string,
  rawText: string,
  now = new Date().toISOString(),
): BookingOutcome {
  const text = normalizeArabic(rawText);
  if (!text.trim()) return { action: 'ignored', reply: null };
  const digits = digitsOf(phone);
  const nowMs = Date.parse(now);
  const tz = clinicTimezone(db, clinicId);
  const todayKey = dateKeyInTz(new Date(nowMs), tz);
  const state = readState(db, clinicId, phone, nowMs);
  const matched = matchPatient(tenant, digits);
  const say = (body: string): BookingOutcome | null => {
    replyText(tenant, phone, matched?.id ?? null, body);
    return null;
  };

  // A cancel word always wins and always clears: no dead-end states.
  if (isCancel(text) && state) {
    clearState(db, clinicId, phone);
    const reply = 'تمام، لغينا الطلب. إذا بدك شي تاني ابعتلنا.';
    say(reply);
    return { action: 'cancelled', reply };
  }

  // --- active confirmation: the "yes" only ever confirms the pending proposal
  if (state?.step === 'awaiting_confirm' && state.dateKey !== null && state.timeMinutes !== null) {
    if (isYes(text)) {
      const outcome = bookPending(db, tenant, clinicId, digits, matched?.id ?? null, state.dateKey, state.timeMinutes, tz, now);
      clearState(db, clinicId, phone);
      if (outcome.reply) say(outcome.reply);
      return outcome;
    }
    if (isNo(text)) {
      clearState(db, clinicId, phone);
      const reply = 'تمام، ما حجزنالك. إذا غيّرت رأيك ابعتلنا اليوم والساعة.';
      say(reply);
      return { action: 'cancelled', reply };
    }
    // Anything else re-proposes if it carries a new date/time, else re-asks.
    const dateKey = parseDate(text, todayKey);
    const time = parseTime(text);
    if (dateKey || time.kind !== 'none') {
      return propose(db, tenant, clinicId, phone, matched?.id ?? null, dateKey ?? state.dateKey ?? todayKey, time, now);
    }
    const reply = `ما فهمت عليك. ${confirmQuestion(state.dateKey, state.timeMinutes)}`;
    say(reply);
    return { action: 'asked_confirm', reply };
  }

  // --- active time-wait: one half of the booking is known, the other missing.
  // timeMinutes < 0 means an ambiguous hour awaiting its meridiem.
  if (state?.step === 'awaiting_time') {
    const time = parseTime(text);
    const pendingHour = state.timeMinutes !== null && state.timeMinutes < 0 ? -state.timeMinutes : null;
    if (time.kind === 'time') {
      if (state.dateKey) {
        return propose(db, tenant, clinicId, phone, matched?.id ?? null, state.dateKey, time, now);
      }
      // Time-first: remember the resolved time, ask for the day.
      writeState(db, clinicId, phone, { step: 'awaiting_time', dateKey: null, timeMinutes: time.minutes, updatedAt: now }, now);
      const reply = `${formatTimeAr(time.minutes)} — أي يوم بيناسبك؟ (مثال: بكرة)`;
      say(reply);
      return { action: 'asked_time', reply };
    }
    if (time.kind === 'ambiguous' && time.hour !== undefined) {
      const reply = state.dateKey
        ? `${time.hour} الصبح ولا المسا؟`
        : `أي يوم؟ (${time.hour} الصبح ولا المسا؟)`;
      writeState(db, clinicId, phone, { step: 'awaiting_time', dateKey: state.dateKey, timeMinutes: -time.hour, updatedAt: now }, now);
      say(reply);
      return { action: 'asked_time', reply };
    }
    // No usable time in this message: maybe it carries the missing half.
    const dateKey = parseDate(text, todayKey);
    if (dateKey) {
      const stored = state.timeMinutes;
      if (stored !== null && stored >= 0) {
        // Time-first flow: the resolved time was waiting for this day.
        return propose(db, tenant, clinicId, phone, matched?.id ?? null, dateKey, { kind: 'time', minutes: stored }, now);
      }
      if (pendingHour !== null) {
        const combined = withMeridiem(pendingHour, text);
        if (combined === null) {
          // Date arrived but the meridiem is still missing: keep both.
          const reply = `تمام، ${formatDateAr(dateKey)}. ${pendingHour} الصبح ولا المسا؟`;
          writeState(db, clinicId, phone, { step: 'awaiting_time', dateKey, timeMinutes: -pendingHour, updatedAt: now }, now);
          say(reply);
          return { action: 'asked_time', reply };
        }
        return propose(db, tenant, clinicId, phone, matched?.id ?? null, dateKey, { kind: 'time', minutes: combined }, now);
      }
      const reply = `تمام، ${formatDateAr(dateKey)}. أي ساعة بيناسبك؟ (مثال: ٥ المسا)`;
      writeState(db, clinicId, phone, { step: 'awaiting_time', dateKey, timeMinutes: null, updatedAt: now }, now);
      say(reply);
      return { action: 'asked_time', reply };
    }
    if (pendingHour !== null) {
      const combined = withMeridiem(pendingHour, text);
      if (combined !== null && state.dateKey) {
        return propose(db, tenant, clinicId, phone, matched?.id ?? null, state.dateKey, { kind: 'time', minutes: combined }, now);
      }
      if (combined !== null) {
        // Meridiem resolved but the day is still unknown: keep the resolved
        // time and ask for the day.
        writeState(db, clinicId, phone, { step: 'awaiting_time', dateKey: null, timeMinutes: combined, updatedAt: now }, now);
        const reply = `${formatTimeAr(combined)} — أي يوم بيناسبك؟ (مثال: بكرة)`;
        say(reply);
        return { action: 'asked_time', reply };
      }
    }
    const reply = state.dateKey
      ? `أي ساعة بيناسبك ${formatDateAr(state.dateKey)}؟ (مثال: ٥ المسا)`
      : 'أي يوم وأي ساعة بيناسبك؟ (مثال: بكرة الساعة ٥ المسا)';
    say(reply);
    return { action: 'asked_time', reply };
  }

  // --- fresh message
  const dateKey = parseDate(text, todayKey);
  const time = parseTime(text);
  const intent = isBookingIntent(text);

  if (time.kind === 'time' && dateKey) {
    // "بكرة الساعة ٥ المسا" is a booking even without the verb.
    return propose(db, tenant, clinicId, phone, matched?.id ?? null, dateKey, time, now);
  }
  if (intent && dateKey && time.kind !== 'none') {
    return propose(db, tenant, clinicId, phone, matched?.id ?? null, dateKey, time, now);
  }
  if (time.kind === 'time' && !dateKey) {
    // Time-first: remember the resolved time, ask for the day.
    const reply = `${formatTimeAr(time.minutes)} — أي يوم بيناسبك؟ (مثال: بكرة)`;
    writeState(db, clinicId, phone, { step: 'awaiting_time', dateKey: null, timeMinutes: time.minutes, updatedAt: now }, now);
    say(reply);
    return { action: 'asked_time', reply };
  }
  if ((intent && dateKey) || (dateKey && time.kind === 'ambiguous')) {
    const key = dateKey ?? todayKey;
    const hour = time.kind === 'ambiguous' && time.hour !== undefined ? time.hour : null;
    const reply =
      hour !== null
        ? `تمام، ${formatDateAr(key)}. ${hour} الصبح ولا المسا؟`
        : `تمام، ${formatDateAr(key)}. أي ساعة بيناسبك؟ (مثال: ٥ المسا)`;
    writeState(db, clinicId, phone, { step: 'awaiting_time', dateKey: key, timeMinutes: hour === null ? null : -hour, updatedAt: now }, now);
    say(reply);
    return { action: 'asked_time', reply };
  }
  if (time.kind === 'ambiguous' && time.hour !== undefined) {
    // Bare ambiguous hour with no day at all: keep the hour, ask for the day.
    const reply = `أي يوم؟ (${time.hour} الصبح ولا المسا؟)`;
    writeState(db, clinicId, phone, { step: 'awaiting_time', dateKey: null, timeMinutes: -time.hour, updatedAt: now }, now);
    say(reply);
    return { action: 'asked_time', reply };
  }
  if (dateKey) {
    // Bare date ("بكرة"): weak intent on its own, strong continuation after
    // "بدي احجز". Either way the next question is the hour.
    const reply = `تمام، ${formatDateAr(dateKey)}. أي ساعة بيناسبك؟ (مثال: ٥ المسا)`;
    writeState(db, clinicId, phone, { step: 'awaiting_time', dateKey, timeMinutes: null, updatedAt: now }, now);
    say(reply);
    return { action: 'asked_time', reply };
  }
  if (intent) {
    const reply = 'أكيد! أي يوم وأي ساعة بيناسبك؟ (مثال: بكرة الساعة ٥ المسا)';
    say(reply);
    return { action: 'asked_time', reply };
  }
  return { action: 'ignored', reply: null };
}

function propose(
  db: Db,
  tenant: TenantHandle,
  clinicId: string,
  phone: string,
  patientId: string | null,
  dateKey: string,
  time: TimeParse,
  now: string,
): BookingOutcome {
  if (time.kind === 'none') {
    const reply = `تمام، ${formatDateAr(dateKey)}. أي ساعة بيناسبك؟ (مثال: ٥ المسا)`;
    writeState(db, clinicId, phone, { step: 'awaiting_time', dateKey, timeMinutes: null, updatedAt: now }, now);
    replyText(tenant, phone, patientId, reply);
    return { action: 'asked_time', reply };
  }
  if (time.kind === 'ambiguous') {
    const reply = `${time.hour} الصبح ولا المسا؟`;
    writeState(db, clinicId, phone, { step: 'awaiting_time', dateKey, timeMinutes: -time.hour, updatedAt: now }, now);
    replyText(tenant, phone, patientId, reply);
    return { action: 'asked_time', reply };
  }
  // A Lebanese patient says round hours ("الساعة ٣"), which rarely sit on the
  // slot grid (the grid shifts after the lunch break). Try the exact requested
  // time first - doctors book off-grid all the time - and only fall back to
  // the nearest grid slot when it is genuinely taken.
  const exact = checkExact(db, tenant, clinicId, dateKey, time.minutes, now);
  if (exact.ok) {
    const reply = confirmQuestion(dateKey, time.minutes);
    writeState(db, clinicId, phone, { step: 'awaiting_confirm', dateKey, timeMinutes: time.minutes, updatedAt: now }, now);
    replyText(tenant, phone, patientId, reply);
    return { action: 'asked_confirm', reply };
  }
  if (exact.reason === 'closed') {
    const reply = `العيادة مسكّرة ${formatDateAr(dateKey)}. بتحب يوم تاني؟`;
    replyText(tenant, phone, patientId, reply);
    return { action: 'closed_day', reply };
  }
  const free = findFreeSlot(db, tenant, clinicId, dateKey, time.minutes, now);
  if (!free.ok) {
    const reply = `ما في محل ${formatDateAr(dateKey)}. بتحب يوم تاني؟`;
    replyText(tenant, phone, patientId, reply);
    return { action: 'closed_day', reply };
  }
  // Requested hour taken: offer the nearest free one instead of failing.
  const reply = `هالوقت محجوز للأسف. في مجال ${formatDateAr(dateKey)} ${formatTimeAr(free.minutes)}؟ رد بنعم أو لا.`;
  writeState(db, clinicId, phone, { step: 'awaiting_confirm', dateKey, timeMinutes: free.minutes, updatedAt: now }, now);
  replyText(tenant, phone, patientId, reply);
  return { action: 'busy_alt', reply };
}

/**
 * Is the exact requested minute bookable? Runs the same validator the staff
 * booking path uses, so the bot can never promise what the calendar refuses.
 */
function checkExact(
  db: Db,
  tenant: TenantHandle,
  clinicId: string,
  dateKey: string,
  minutes: number,
  now: string,
): { ok: true } | { ok: false; reason: 'closed' | 'busy' } {
  const ctx = bookingContextFor(db, clinicId);
  const duration = ctx.schedule.slotDurationMinutes ?? 30;
  const hh = String(Math.floor(minutes / 60)).padStart(2, '0');
  const mm = String(minutes % 60).padStart(2, '0');
  const startsAt = zonedTimeToUtc(dateKey, `${hh}:${mm}`, ctx.timeZone).toISOString();
  const appointments = loadAppointmentsForRange(
    tenant,
    zonedTimeToUtc(dateKey, '00:00', ctx.timeZone).toISOString(),
    zonedTimeToUtc(addDaysToDateKey(dateKey, 1), '00:00', ctx.timeZone).toISOString(),
  );
  const check = validateBooking(
    { startsAt, durationMinutes: duration, doctorId: null, isPublicBooking: false },
    {
      schedule: ctx.schedule,
      timeZone: ctx.timeZone,
      appointments,
      now,
      doctorId: null,
      booking: {
        minNoticeHours: ctx.booking.minNoticeHours,
        maxAdvanceDays: ctx.booking.maxAdvanceDays,
        maxDailyAppointments: ctx.booking.maxDailyAppointments,
      },
    },
  );
  if (check.ok) return { ok: true };
  if (
    check.reason === 'closed_day' ||
    check.reason === 'holiday' ||
    check.reason === 'outside_working_hours' ||
    check.reason === 'blocked_window'
  ) {
    return { ok: false, reason: 'closed' };
  }
  return { ok: false, reason: 'busy' };
}

interface FreeSlot {
  ok: boolean;
  minutes: number;
  reason?: 'closed' | 'full';
}

/** Nearest free slot at or after the requested time, same day. */
function findFreeSlot(
  db: Db,
  tenant: TenantHandle,
  clinicId: string,
  dateKey: string,
  minutes: number,
  now: string,
): FreeSlot {
  const ctx = bookingContextFor(db, clinicId);
  const duration = ctx.schedule.slotDurationMinutes ?? 30;
  const slots = availableSlots(tenant, ctx, { fromDateKey: dateKey, toDateKey: dateKey, durationMinutes: duration, now });
  if (slots.length === 0) return { ok: false, minutes, reason: 'closed' };
  const starts = slots.map((s) => {
    const [h, m] = s.localStart.split(':').map(Number);
    return (h ?? 0) * 60 + (m ?? 0);
  });
  if (starts.includes(minutes)) return { ok: true, minutes };
  const later = starts.filter((m) => m > minutes).sort((a, b) => a - b);
  if (later.length > 0) return { ok: true, minutes: later[0] as number };
  return { ok: false, minutes, reason: 'full' };
}

function bookPending(
  db: Db,
  tenant: TenantHandle,
  clinicId: string,
  digits: string,
  patientId: string | null,
  dateKey: string,
  minutes: number,
  tz: string,
  now: string,
): BookingOutcome {
  let pid = patientId;
  if (!pid && digits.length >= 7) {
    const created = createPatient(tenant, clinicId, {
      firstName: 'زبون',
      lastName: 'واتساب',
      phone: `+${digits}`,
      preferredLanguage: 'ar',
      whatsappOptIn: true,
      source: 'whatsapp_inbound',
      createdBy: 'whatsapp',
    }, '961');
    pid = created.id;
  }
  const hh = String(Math.floor(minutes / 60)).padStart(2, '0');
  const mm = String(minutes % 60).padStart(2, '0');
  const startsAt = zonedTimeToUtc(dateKey, `${hh}:${mm}`, tz).toISOString();
  try {
    createBooking(db, tenant, clinicId, bookingContextFor(db, clinicId), {
      patientId: pid,
      patientName: 'زبون واتساب',
      patientPhone: `+${digits}`,
      startsAt,
      source: 'whatsapp_inbound',
      status: 'pending',
      quiet: true,
      createdBy: 'whatsapp',
      notes: 'حجز عبر واتساب - بانتظار تأكيد الموظفة',
    }, now);
  } catch (error) {
    if (error instanceof ApiError && error.code === 'conflict') {
      // Raced or became invalid between proposal and yes: offer the day again.
      const reply = `انحجز هالوقت قبل ما تأكد للأسف. ابعتلي يوم وساعة تانيين.`;
      replyText(tenant, digits, pid, reply);
      return { action: 'busy_alt', reply };
    }
    throw error;
  }
  const reply = `تمام! استلمنا طلبك لموعد ${formatDateAr(dateKey)} ${formatTimeAr(minutes)}. الموظفة بتأكدلك الحجز وبتبعتلك رسالة.`;
  replyText(tenant, digits, pid, reply);
  return { action: 'booked_pending', reply };
}
