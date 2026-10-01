/**
 * Tests for the scheduling engine.
 *
 * The bugs that matter here are timezone and overlap bugs: a slot published at
 * the wrong UTC instant, a buffer ignored so the clinic runs late all day, a
 * cancelled slot that stays occupied, and a waitlist offer sent to a patient
 * who cannot attend.
 */

import { describe, expect, it } from 'vitest';

import {
  explainEmptyDay,
  findAvailableSlots,
  generateSlots,
  isRangeFree,
  occupiesSlot,
  validateBooking,
  type Slot,
} from '../src/scheduling/slots.js';
import { decideDeposit, isHoldExpired } from '../src/scheduling/deposit.js';
import {
  buildOffer,
  expiredOffers,
  fillFreedSlot,
  markOffered,
  rankCandidates,
  summariseWaitlist,
  waitlistScore,
} from '../src/scheduling/waitlist.js';
import {
  cancelReminders,
  isInsideQuietHours,
  planReminders,
  pushOutOfQuietHours,
} from '../src/scheduling/reminders.js';
import type { Appointment, ClinicSchedule, ReminderPolicy, WaitlistEntry } from '../src/domain/types.js';

const TZ = 'Asia/Riyadh';
const CLINIC = 'clinic_1';

/** Sunday-Thursday 09:00-17:00 with a 12:00-13:00 break, matching Gulf clinics. */
function schedule(overrides: Partial<ClinicSchedule> = {}): ClinicSchedule {
  return {
    id: 'sch_1',
    clinicId: CLINIC,
    workingHours: [
      { weekday: 0, enabled: true, start: '09:00', end: '17:00', breaks: [] },
      { weekday: 1, enabled: true, start: '09:00', end: '17:00', breaks: [] },
      { weekday: 2, enabled: true, start: '09:00', end: '17:00', breaks: [{ start: '12:00', end: '13:00', label: 'Lunch' }] },
      { weekday: 3, enabled: true, start: '09:00', end: '17:00', breaks: [] },
      { weekday: 4, enabled: true, start: '09:00', end: '15:00', breaks: [] },
      { weekday: 5, enabled: false, start: '09:00', end: '17:00', breaks: [] },
      { weekday: 6, enabled: false, start: '09:00', end: '17:00', breaks: [] },
    ],
    slotDurationMinutes: 30,
    bufferMinutes: 0,
    maxDailyAppointments: null,
    holidays: [],
    blockedWindows: [],
    slotIntervalMinutes: 30,
    allowWalkIn: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function appointment(overrides: Partial<Appointment> = {}): Appointment {
  return {
    id: 'appt_1',
    clinicId: CLINIC,
    patientId: 'pat_1',
    doctorId: 'doc_1',
    startsAt: '2026-03-11T06:00:00.000Z',
    endsAt: '2026-03-11T06:30:00.000Z',
    timezone: TZ,
    status: 'confirmed',
    reason: null,
    notes: null,
    visitType: 'consultation',
    source: 'staff',
    isPublicBooking: false,
    holdExpiresAt: null,
    depositRequiredMinor: 0,
    depositPaidMinor: 0,
    feeMinor: 20000,
    paidMinor: 0,
    cancelledAt: null,
    cancelledBy: null,
    cancellationReason: null,
    checkedInAt: null,
    completedAt: null,
    rescheduledFromId: null,
    confirmationToken: 'tok_1',
    createdBy: null,
    patientName: 'Sara',
    patientPhone: '+966500000000',
    specialty: 'general_medicine',
    doctorName: 'Dr Ahmed',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function waitlistEntry(overrides: Partial<WaitlistEntry> = {}): WaitlistEntry {
  return {
    id: 'wl_1',
    clinicId: CLINIC,
    patientId: 'pat_2',
    specialty: 'general_medicine',
    doctorId: null,
    preferredDateFrom: null,
    preferredDateTo: null,
    preferredTimeWindows: [],
    note: null,
    priority: 0,
    status: 'waiting',
    offeredAppointmentId: null,
    offeredSlotStart: null,
    offeredSlotEnd: null,
    offerExpiresAt: null,
    offers: 0,
    lastOfferedAt: null,
    createdAt: '2026-03-01T00:00:00.000Z',
    updatedAt: '2026-03-01T00:00:00.000Z',
    ...overrides,
  };
}

const REMINDER_POLICY: ReminderPolicy = {
  enabled: true,
  defaultOffsetsMinutes: [1440, 120],
  channels: ['whatsapp'],
  template: 'appointment_reminder',
  chronicExtraOffsetsMinutes: [4320],
  quietHours: { startHour: 22, endHour: 7 },
  minLeadMinutes: 30,
  paused: false,
};

describe('slot generation', () => {
  it('publishes slots on the configured grid', () => {
    const slots = generateSlots({ schedule: schedule(), timeZone: TZ, dateKey: '2026-03-08' });
    // Sunday 09:00-17:00 at 30 min = 16 slots.
    expect(slots).toHaveLength(16);
    expect(slots[0]?.localStart).toBe('09:00');
    expect(slots[15]?.localStart).toBe('16:30');
  });

  it('subtracts the break and does not drift the grid after it', () => {
    const slots = generateSlots({ schedule: schedule(), timeZone: TZ, dateKey: '2026-03-10' });
    const starts = slots.map((s) => s.localStart);
    expect(starts).toContain('11:30');
    // The break must not appear, and the afternoon must restart at 13:00.
    expect(starts).not.toContain('12:00');
    expect(starts).not.toContain('12:30');
    expect(starts).toContain('13:00');
  });

  it('converts clinic-local time to the correct UTC instant', () => {
    // Riyadh is UTC+3 year round.
    const slots = generateSlots({ schedule: schedule(), timeZone: TZ, dateKey: '2026-03-08' });
    expect(slots[0]?.startsAt).toBe('2026-03-08T06:00:00.000Z');
  });

  it('returns nothing on a closed day', () => {
    // Friday.
    const slots = generateSlots({ schedule: schedule(), timeZone: TZ, dateKey: '2026-03-13' });
    expect(slots).toEqual([]);
  });

  it('returns nothing on a holiday and explains why', () => {
    const s = schedule({ holidays: [{ date: '2026-03-09', label: 'Founding Day' }] });
    expect(generateSlots({ schedule: s, timeZone: TZ, dateKey: '2026-03-09' })).toEqual([]);
    expect(explainEmptyDay(s, TZ, '2026-03-09')).toBe('holiday');
  });

  it('subtracts blocked windows', () => {
    const s = schedule({ blockedWindows: [{ date: '2026-03-08', start: '10:00', end: '11:00', label: 'Conference' }] });
    const starts = generateSlots({ schedule: s, timeZone: TZ, dateKey: '2026-03-08' }).map((x) => x.localStart);
    expect(starts).not.toContain('10:00');
    expect(starts).not.toContain('10:30');
    expect(starts).toContain('11:00');
  });

  it('honours a longer visit duration', () => {
    const slots = generateSlots({ schedule: schedule(), timeZone: TZ, dateKey: '2026-03-08', durationMinutes: 60 });
    expect(slots[0]?.localStart).toBe('09:00');
    expect(slots[1]?.localStart).toBe('10:00');
  });

  it('never produces a slot that overruns closing time', () => {
    const slots = generateSlots({ schedule: schedule(), timeZone: TZ, dateKey: '2026-03-08', durationMinutes: 45 });
    for (const slot of slots) expect(slot.localEnd <= '17:00').toBe(true);
  });
});

describe('availability', () => {
  it('removes slots taken by existing appointments', () => {
    const slots = findAvailableSlots(
      { schedule: schedule(), timeZone: TZ, appointments: [appointment()], now: '2026-03-01T00:00:00.000Z' },
      '2026-03-11',
      '2026-03-11',
    );
    const starts = slots.map((s) => s.localStart);
    expect(starts).not.toContain('09:00');
    expect(starts).toContain('09:30');
  });

  it('applies the buffer to both sides of an appointment', () => {
    const withBuffer = findAvailableSlots(
      {
        schedule: schedule({ bufferMinutes: 15 }),
        timeZone: TZ,
        appointments: [appointment()],
        now: '2026-03-01T00:00:00.000Z',
      },
      '2026-03-11',
      '2026-03-11',
    );
    // 09:00-09:30 booked, buffer 15 => nothing may start until 09:45.
    const starts = withBuffer.map((s) => s.localStart);
    expect(starts).not.toContain('09:00');
    expect(starts).not.toContain('09:30');
    expect(starts).toContain('10:00');
  });

  it('frees the slot when the appointment is cancelled', () => {
    const slots = findAvailableSlots(
      {
        schedule: schedule(),
        timeZone: TZ,
        appointments: [appointment({ status: 'cancelled' })],
        now: '2026-03-01T00:00:00.000Z',
      },
      '2026-03-11',
      '2026-03-11',
    );
    expect(slots.map((s) => s.localStart)).toContain('09:00');
  });

  it('still holds a slot for a live public hold', () => {
    const held = appointment({ isPublicBooking: true, holdExpiresAt: '2026-03-11T05:00:00.000Z', status: 'scheduled' });
    const slots = findAvailableSlots(
      { schedule: schedule(), timeZone: TZ, appointments: [held], now: '2026-03-01T00:00:00.000Z' },
      '2026-03-11',
      '2026-03-11',
    );
    expect(slots.map((s) => s.localStart)).not.toContain('09:00');
  });

  it('releases the slot once the hold expires', () => {
    const expired = appointment({ isPublicBooking: true, holdExpiresAt: '2026-03-10T00:00:00.000Z' });
    const slots = findAvailableSlots(
      { schedule: schedule(), timeZone: TZ, appointments: [expired], now: '2026-03-11T00:00:00.000Z' },
      '2026-03-11',
      '2026-03-11',
    );
    expect(slots.map((s) => s.localStart)).toContain('09:00');
  });

  it('treats a no-show as freeing the slot', () => {
    expect(occupiesSlot(appointment({ status: 'no_show' }))).toBe(false);
    expect(occupiesSlot(appointment({ status: 'rescheduled' }))).toBe(false);
    expect(occupiesSlot(appointment({ status: 'confirmed' }))).toBe(true);
  });

  it('ignores its own appointment when rescheduling', () => {
    const free = isRangeFree('2026-03-11T06:00:00.000Z', '2026-03-11T06:30:00.000Z', [appointment()], {
      ignoreAppointmentId: 'appt_1',
      now: '2026-03-01T00:00:00.000Z',
    });
    expect(free).toBe(true);
  });
});

describe('booking validation', () => {
  const base = () => ({
    schedule: schedule(),
    timeZone: TZ,
    appointments: [appointment()],
    now: '2026-03-01T00:00:00.000Z',
    booking: { minNoticeHours: 2, maxAdvanceDays: 60, maxDailyAppointments: null as number | null },
  });

  it('accepts a free in-hours slot', () => {
    const result = validateBooking({ startsAt: '2026-03-11T07:00:00.000Z' }, base());
    expect(result.ok).toBe(true);
  });

  it('rejects a slot that clashes', () => {
    const result = validateBooking({ startsAt: '2026-03-11T06:00:00.000Z' }, base());
    expect(result).toEqual({ ok: false, reason: 'slot_taken' });
  });

  it('rejects a booking inside the break', () => {
    // Tuesday 12:30 Riyadh = 09:30 UTC, inside the 12:00-13:00 lunch break.
    const result = validateBooking({ startsAt: '2026-03-10T09:30:00.000Z' }, base());
    expect(result).toEqual({ ok: false, reason: 'blocked_window' });
  });

  it('rejects a booking outside working hours', () => {
    // 16:00 UTC = 19:00 Riyadh, past the 17:00 close.
    const result = validateBooking({ startsAt: '2026-03-11T16:00:00.000Z' }, base());
    expect(result).toEqual({ ok: false, reason: 'outside_working_hours' });
  });

  it('rejects a closed day', () => {
    // Friday.
    const result = validateBooking({ startsAt: '2026-03-13T06:00:00.000Z' }, base());
    expect(result).toEqual({ ok: false, reason: 'closed_day' });
  });

  it('rejects a holiday', () => {
    const s = schedule({ holidays: [{ date: '2026-03-09', label: 'Holiday' }] });
    const result = validateBooking({ startsAt: '2026-03-09T06:00:00.000Z' }, { ...base(), schedule: s });
    expect(result).toEqual({ ok: false, reason: 'holiday' });
  });

  it('enforces minimum notice', () => {
    const result = validateBooking(
      { startsAt: '2026-03-01T01:00:00.000Z' },
      { ...base(), now: '2026-03-01T00:00:00.000Z' },
    );
    expect(result).toEqual({ ok: false, reason: 'min_notice' });
  });

  it('enforces the booking horizon', () => {
    const result = validateBooking({ startsAt: '2026-06-01T06:00:00.000Z' }, base());
    expect(result).toEqual({ ok: false, reason: 'too_far_ahead' });
  });

  it('enforces the daily cap', () => {
    const result = validateBooking(
      { startsAt: '2026-03-11T07:00:00.000Z' },
      { ...base(), booking: { minNoticeHours: 2, maxAdvanceDays: 60, maxDailyAppointments: 1 } },
    );
    expect(result).toEqual({ ok: false, reason: 'max_daily' });
  });
});

describe('deposits', () => {
  const base = () => ({
    booking: {
      enabled: true,
      minNoticeHours: 0,
      maxAdvanceDays: 60,
      holdMinutes: 15,
      autoConfirmWithoutDeposit: false,
      requirePhoneVerification: true,
      allowWaitlistJoin: true,
      bufferMinutes: 0,
    },
    clinicRequiresDeposit: true,
    feeMinor: 20000,
    isPublicBooking: true,
    source: 'public_booking' as const,
  });

  it('requires half the fee from a public booking', () => {
    const decision = decideDeposit(base());
    expect(decision.requiredMinor).toBe(10000);
    expect(decision.satisfied).toBe(false);
    expect(decision.action).toBe('await_deposit');
  });

  it('exempts staff bookings', () => {
    const decision = decideDeposit({ ...base(), isPublicBooking: false, source: 'staff' });
    expect(decision.exempt).toBe(true);
    expect(decision.exemptionReason).toBe('staff_booking');
  });

  it('exempts an exempt patient', () => {
    const decision = decideDeposit({ ...base(), patientExempt: true });
    expect(decision.exempt).toBe(true);
    expect(decision.exemptionReason).toBe('patient_exempt');
  });

  it('exempts when the clinic turned deposits off', () => {
    const decision = decideDeposit({ ...base(), clinicRequiresDeposit: false });
    expect(decision.exemptionReason).toBe('clinic_policy_off');
  });

  it('is satisfied once the deposit is paid', () => {
    const decision = decideDeposit({ ...base(), waivedMinor: 10000 });
    expect(decision.satisfied).toBe(true);
    expect(decision.action).toBe('confirm');
  });

  it('never requires more than the fee', () => {
    const decision = decideDeposit({ ...base(), defaultDepositMinor: 999999 });
    expect(decision.outstandingMinor).toBe(decision.requiredMinor);
  });

  it('expires a hold but keeps a confirmed appointment', () => {
    const now = '2026-03-11T00:00:00.000Z';
    // A pending public hold whose window has passed is released.
    expect(
      isHoldExpired(
        appointment({ status: 'scheduled', isPublicBooking: true, holdExpiresAt: '2026-03-10T00:00:00.000Z' }),
        now,
      ),
    ).toBe(true);
    // A confirmed appointment keeps its hold metadata but is never "expired".
    expect(
      isHoldExpired(
        appointment({ status: 'confirmed', isPublicBooking: true, holdExpiresAt: '2026-03-10T00:00:00.000Z' }),
        now,
      ),
    ).toBe(false);
    expect(isHoldExpired(appointment({ holdExpiresAt: null }), now)).toBe(false);
  });
});

describe('waitlist', () => {
  const slot: Slot = {
    startsAt: '2026-03-11T06:00:00.000Z',
    endsAt: '2026-03-11T06:30:00.000Z',
    dateKey: '2026-03-11',
    localStart: '09:00',
    localEnd: '09:30',
    durationMinutes: 30,
  };

  it('ranks clinical priority above waiting time', () => {
    const urgent = waitlistScore(waitlistEntry({ priority: 5, createdAt: '2026-03-10T00:00:00.000Z' }), slot);
    const patient = waitlistScore(waitlistEntry({ priority: 0, createdAt: '2026-01-01T00:00:00.000Z' }), slot);
    expect(urgent).toBeGreaterThan(patient);
  });

  it('skips a patient whose date range excludes the slot', () => {
    const { matches, rejected } = rankCandidates(
      [waitlistEntry({ preferredDateFrom: '2026-04-01', preferredDateTo: '2026-04-30' })],
      { slot },
    );
    expect(matches).toHaveLength(0);
    expect(rejected[0]?.reason).toBe('outside_date_range');
  });

  it('skips a patient whose time window excludes the slot', () => {
    const { matches, rejected } = rankCandidates(
      [waitlistEntry({ preferredTimeWindows: [{ start: '14:00', end: '17:00' }] })],
      { slot },
    );
    expect(matches).toHaveLength(0);
    expect(rejected[0]?.reason).toBe('outside_time_window');
  });

  it('offers the slot to the best candidate', () => {
    const result = fillFreedSlot({
      clinicId: CLINIC,
      slot,
      schedule: schedule(),
      timeZone: TZ,
      appointments: [],
      waitlist: [
        waitlistEntry({ id: 'wl_low', patientId: 'pat_low', priority: 0 }),
        waitlistEntry({ id: 'wl_high', patientId: 'pat_high', priority: 9 }),
      ],
      now: '2026-03-10T00:00:00.000Z',
    });
    expect(result.offers).toHaveLength(1);
    expect(result.offers[0]?.entryId).toBe('wl_high');
  });

  it('does not offer the same slot to several patients at once', () => {
    const result = fillFreedSlot({
      clinicId: CLINIC,
      slot,
      schedule: schedule(),
      timeZone: TZ,
      appointments: [],
      waitlist: [
        waitlistEntry({ id: 'wl_a', patientId: 'pat_a' }),
        waitlistEntry({ id: 'wl_b', patientId: 'pat_b' }),
      ],
      now: '2026-03-10T00:00:00.000Z',
    });
    expect(result.offers).toHaveLength(1);
    // The loser stays queued rather than being silently dropped.
    expect(result.nextInLine?.id).toBe('wl_b');
  });

  it('skips a patient who already has a clashing appointment', () => {
    const result = fillFreedSlot({
      clinicId: CLINIC,
      slot,
      schedule: schedule(),
      timeZone: TZ,
      appointments: [appointment({ patientId: 'pat_2' })],
      waitlist: [waitlistEntry({ patientId: 'pat_2' })],
      now: '2026-03-10T00:00:00.000Z',
    });
    expect(result.offers).toHaveLength(0);
    expect(result.rejected[0]?.reason).toBe('already_booked');
  });

  it('builds a dedupe key that cannot produce a second offer for one slot', () => {
    const offer = buildOffer({ entry: waitlistEntry(), slot, now: '2026-03-10T00:00:00.000Z' });
    expect(offer.dedupeKey).toBe('waitlist_offer:wl_1:2026-03-11T06:00:00.000Z');
    expect(new Date(offer.expiresAt).getTime()).toBeGreaterThan(new Date('2026-03-10T00:00:00.000Z').getTime());
  });

  it('tracks an offer on the entry', () => {
    const offer = buildOffer({ entry: waitlistEntry(), slot });
    const entry = markOffered(waitlistEntry(), offer, '2026-03-10T00:00:00.000Z');
    expect(entry.status).toBe('offered');
    expect(entry.offers).toBe(1);
  });

  it('returns lapsed offers to the queue', () => {
    const offer = buildOffer({ entry: waitlistEntry(), slot, now: '2026-03-10T00:00:00.000Z', ttlMinutes: 30 });
    const offered = markOffered(waitlistEntry(), offer, '2026-03-10T00:00:00.000Z');
    expect(expiredOffers([offered], '2026-03-10T00:30:00.000Z')).toHaveLength(1);
    expect(expiredOffers([offered], '2026-03-10T00:29:00.000Z')).toHaveLength(0);
  });

  it('summarises the queue', () => {
    const stats = summariseWaitlist([
      waitlistEntry({ status: 'waiting' }),
      waitlistEntry({ status: 'booked' }),
      waitlistEntry({ status: 'cancelled' }),
    ]);
    expect(stats.waiting).toBe(1);
    expect(stats.booked).toBe(1);
    expect(stats.filledFromWaitlist).toBe(1);
  });
});

describe('reminders', () => {
  const future = appointment({ startsAt: '2026-03-12T06:00:00.000Z' });

  it('plans one reminder per offset per channel', () => {
    const plan = planReminders({
      appointment: future,
      policy: REMINDER_POLICY,
      clinicId: CLINIC,
      now: '2026-03-01T00:00:00.000Z',
    });
    expect(plan.reminders).toHaveLength(2);
    expect(plan.reminders.map((r) => r.offsetMinutes).sort((a, b) => b - a)).toEqual([1440, 120]);
  });

  it('adds the chronic extra offsets', () => {
    const plan = planReminders({
      appointment: future,
      policy: REMINDER_POLICY,
      clinicId: CLINIC,
      chronic: true,
      now: '2026-03-01T00:00:00.000Z',
    });
    expect(plan.reminders.map((r) => r.offsetMinutes).sort((a, b) => b - a)).toEqual([4320, 1440, 120]);
  });

  it('drops an offset that would land inside quiet hours with no room to move', () => {
    // 07:00 Riyadh appointment, 2h reminder = 05:00 local, inside quiet hours.
    const early = appointment({ startsAt: '2026-03-12T04:00:00.000Z' });
    const plan = planReminders({
      appointment: early,
      policy: REMINDER_POLICY,
      clinicId: CLINIC,
      now: '2026-03-11T00:00:00.000Z',
    });
    const twoHours = plan.skipped.find((s) => s.offsetMinutes === 120);
    expect(twoHours?.reason).toBe('inside_quiet_hours');
  });

  it('moves a quiet-hours reminder to the boundary when there is room', () => {
    // 23:00 Riyadh appointment: the 2h reminder lands at 21:00, which is fine.
    const late = appointment({ startsAt: '2026-03-12T20:00:00.000Z' });
    const plan = planReminders({
      appointment: late,
      policy: REMINDER_POLICY,
      clinicId: CLINIC,
      now: '2026-03-12T00:00:00.000Z',
    });
    const twoHours = plan.reminders.find((r) => r.offsetMinutes === 120);
    expect(twoHours?.scheduledFor).toBe('2026-03-12T18:00:00.000Z');
  });

  it('drops reminders closer than the minimum lead', () => {
    const plan = planReminders({
      appointment: future,
      policy: { ...REMINDER_POLICY, defaultOffsetsMinutes: [10, 1440] },
      clinicId: CLINIC,
      now: '2026-03-01T00:00:00.000Z',
    });
    expect(plan.reminders.map((r) => r.offsetMinutes)).toEqual([1440]);
    expect(plan.skipped[0]?.reason).toBe('too_close');
  });

  it('sends nothing for a cancelled appointment', () => {
    const plan = planReminders({
      appointment: { ...future, status: 'cancelled' },
      policy: REMINDER_POLICY,
      clinicId: CLINIC,
      now: '2026-03-01T00:00:00.000Z',
    });
    expect(plan.reminders).toHaveLength(0);
    expect(plan.skipped[0]?.reason).toBe('appointment_cancelled');
  });

  it('sends nothing when the policy is paused', () => {
    const plan = planReminders({
      appointment: future,
      policy: { ...REMINDER_POLICY, paused: true },
      clinicId: CLINIC,
      now: '2026-03-01T00:00:00.000Z',
    });
    expect(plan.skipped[0]?.reason).toBe('policy_paused');
  });

  it('sends nothing without a contactable number', () => {
    const plan = planReminders({
      appointment: { ...future, patientPhone: '' },
      policy: REMINDER_POLICY,
      clinicId: CLINIC,
      now: '2026-03-01T00:00:00.000Z',
    });
    expect(plan.skipped[0]?.reason).toBe('no_contactable_number');
  });

  it('handles quiet hours that wrap past midnight', () => {
    const quiet = { startHour: 22, endHour: 7 };
    expect(isInsideQuietHours('2026-03-11T20:00:00.000Z', quiet, TZ)).toBe(true); // 23:00 local
    expect(isInsideQuietHours('2026-03-11T02:00:00.000Z', quiet, TZ)).toBe(true); // 05:00 local
    expect(isInsideQuietHours('2026-03-11T10:00:00.000Z', quiet, TZ)).toBe(false); // 13:00 local
  });

  it('releases quiet hours at the local boundary, not the UTC hour', () => {
    // 23:00 local on 11 March. Riyadh is UTC+3, so quiet ends 07:00 local =
    // 04:00 UTC on 12 March. Setting the UTC hour instead would have sent at
    // 07:00 UTC = 10:00 local, three hours late.
    const pushed = pushOutOfQuietHours('2026-03-11T20:00:00.000Z', { startHour: 22, endHour: 7 }, TZ);
    expect(pushed).toBe('2026-03-12T04:00:00.000Z');
    expect(isInsideQuietHours(pushed, { startHour: 22, endHour: 7 }, TZ)).toBe(false);
  });

  it('releases before midnight when the boundary is still ahead the same day', () => {
    // 02:00 local on 12 March is inside quiet hours; it ends 07:00 local the
    // same day, so no day rollover is needed.
    const pushed = pushOutOfQuietHours('2026-03-11T23:00:00.000Z', { startHour: 22, endHour: 7 }, TZ);
    expect(pushed).toBe('2026-03-12T04:00:00.000Z');
  });

  it('leaves a message outside quiet hours untouched', () => {
    const instant = '2026-03-11T10:00:00.000Z';
    expect(pushOutOfQuietHours(instant, { startHour: 22, endHour: 7 }, TZ)).toBe(instant);
  });

  it('cancels outstanding reminders when an appointment moves', () => {
    const plan = planReminders({
      appointment: future,
      policy: REMINDER_POLICY,
      clinicId: CLINIC,
      now: '2026-03-01T00:00:00.000Z',
    });
    const cancelled = cancelReminders(plan.reminders, 'appointment_cancelled', '2026-03-02T00:00:00.000Z');
    expect(cancelled.every((r) => r.status === 'cancelled')).toBe(true);
    expect(cancelled[0]?.origin).toBe('auto_cancelled');
  });
});
