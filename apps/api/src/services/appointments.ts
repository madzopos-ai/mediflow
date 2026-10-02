/**
 * Booking logic.
 *
 * The ordering here is the whole point. Availability is checked *and* the row
 * is inserted inside a single SQLite transaction. Checking first and writing
 * afterwards would let two receptionists booking the last 09:00 slot both
 * succeed, and the clinic would be double-booked.
 *
 * SQLite serialises write transactions, so `BEGIN IMMEDIATE` is what actually
 * provides that guarantee; better-sqlite3 uses it for `db.transaction` when the
 * transaction is a write.
 */

import {
  addDaysToDateKey,
  addMinutes,
  createId,
  createToken,
  findAvailableSlots,
  toIso,
  validateBooking,
  zonedTimeToUtc,
  type Appointment,
  type AppointmentStatus,
  type ClinicSchedule,
  type Slot,
  type Specialty,
} from '@mediflow/shared';

import type { Db } from '../db/index.js';
import type { TenantHandle } from '../db/tenant.js';
import { bit, nullable, toAppointment, type Row } from '../db/mappers.js';
import { queueBookingConfirmation, scheduleAppointmentReminders } from './reminders.js';
import { clinicTimezone, readSchedule, readSettings } from './settings.js';
import { ApiError } from '../http/errors.js';

export interface BookingContext {
  schedule: ClinicSchedule;
  timeZone: string;
  booking: {
    minNoticeHours: number;
    maxAdvanceDays: number;
    maxDailyAppointments: number | null;
    /** When true, a booking with no deposit requirement confirms immediately. */
    autoConfirmWithoutDeposit: boolean;
  };
  deposit: {
    require: boolean;
    amountMinor: number;
    holdMinutes: number;
  };
}

export interface CreateBookingInput {
  patientId: string | null;
  patientName: string;
  patientPhone: string;
  startsAt: string;
  durationMinutes?: number;
  doctorId?: string | null;
  doctorName?: string | null;
  specialty?: Specialty;
  reason?: string | null;
  notes?: string | null;
  visitType?: Appointment['visitType'];
  source?: Appointment['source'];
  isPublicBooking?: boolean;
  feeMinor?: number;
  createdBy?: string | null;
  /**
   * Override the computed status. WhatsApp bookings arrive as 'pending':
   * held on the calendar but awaiting staff confirmation.
   */
  status?: AppointmentStatus;
  /**
   * Skip the post-commit confirmation + reminder scheduling. Used with
   * status 'pending': nothing may go out until a human confirms. The staff
   * confirm action schedules both explicitly.
   */
  quiet?: boolean;
}

/** Appointments that occupy a slot, for a date range, in this clinic only. */
/**
 * Assemble the booking policy for one clinic.
 *
 * Read fresh on every booking attempt rather than cached: a receptionist
 * changing the schedule or the deposit requirement must take effect on the next
 * request, not on the next deploy.
 */
export function bookingContextFor(db: Db, clinicId: string): BookingContext {
  const settings = readSettings(db, clinicId);
  const timeZone = clinicTimezone(db, clinicId);
  const schedule = readSchedule(db, clinicId);
  return {
    schedule,
    timeZone,
    booking: {
      minNoticeHours: settings.booking.minNoticeHours,
      maxAdvanceDays: settings.booking.maxAdvanceDays,
      maxDailyAppointments: schedule.maxDailyAppointments,
      autoConfirmWithoutDeposit: settings.booking.autoConfirmWithoutDeposit,
    },
    deposit: {
      require: settings.features.requireDepositOnBooking,
      amountMinor: settings.features.defaultDepositAmountMinor,
      holdMinutes: settings.booking.holdMinutes,
    },
  };
}

export function loadAppointmentsForRange(
  db: TenantHandle,
  fromIso: string,
  toIso_: string,
): Appointment[] {
  return db
    .all<Row>('appointments', 'starts_at < ? AND ends_at > ?', [toIso_, fromIso])
    .map(toAppointment);
}

export interface AvailabilityQuery {
  fromDateKey: string;
  toDateKey: string;
  durationMinutes?: number;
  doctorId?: string | null;
  now?: string;
}

/** Free slots for a date range, already filtered against real bookings. */
export function availableSlots(db: TenantHandle, ctx: BookingContext, query: AvailabilityQuery): Slot[] {
  return findAvailableSlots(
    {
      schedule: ctx.schedule,
      timeZone: ctx.timeZone,
      appointments: loadAppointmentsForRange(
        db,
        // Local midnight converted to UTC, not a UTC midnight. For a clinic at
        // UTC+3, `${dateKey}T00:00:00.000Z` is 03:00 local and would exclude the
        // early-morning slots the patient is being offered.
        zonedTimeToUtc(query.fromDateKey, '00:00', ctx.timeZone).toISOString(),
        // The upper bound is exclusive, so it is the next local midnight.
        zonedTimeToUtc(addDaysToDateKey(query.toDateKey, 1), '00:00', ctx.timeZone).toISOString(),
      ),
      durationMinutes: query.durationMinutes,
      doctorId: query.doctorId ?? null,
      now: query.now,
    },
    query.fromDateKey,
    query.toDateKey,
  );
}

/** Human-readable explanation of why a day is empty, for the booking screen. */
export function explainDay(
  db: TenantHandle,
  ctx: BookingContext,
  dateKey: string,
  durationMinutes: number,
  now: string,
): string {
  const slots = availableSlots(db, ctx, { fromDateKey: dateKey, toDateKey: dateKey, durationMinutes, now });
  if (slots.length > 0) return `${slots.length} slot(s) available.`;

  if (ctx.schedule.holidays.some((h) => h.date === dateKey)) {
    return 'The clinic is closed for a holiday.';
  }

  // Distinguish "closed" from "fully booked": availability found no slots and
  // the working day is enabled, so every slot on this date is taken. (An
  // earlier version probed `isRangeFree` with an empty range, which always
  // reports "not free" and mislabelled fully-booked days as closed.)
  const weekday = weekdayOf(dateKey);
  const workingDay = ctx.schedule.workingHours.find((d) => d.enabled && d.weekday === weekday);
  if (!workingDay) return 'The clinic is closed on this date.';
  return 'All slots on this date are already booked.';
}

/** 0 = Sunday, matching the `weekday` field of a working-hours entry. */
function weekdayOf(dateKey: string): number {
  return new Date(`${dateKey}T00:00:00.000Z`).getUTCDay();
}

/**
 * Create an appointment, rejecting any that would double-book.
 *
 * Throws ApiError(409) with the specific rejection reason so the caller can show
 * the patient something actionable.
 */
export function createBooking(
  db: Db,
  tenant: TenantHandle,
  clinicId: string,
  ctx: BookingContext,
  input: CreateBookingInput,
  now = new Date().toISOString(),
): Appointment {
  const duration = input.durationMinutes ?? ctx.schedule.slotDurationMinutes;
  const isPublic = input.isPublicBooking ?? false;
  const startsAt = input.startsAt;
  const endsAt = toIso(addMinutes(new Date(startsAt), duration));

  const feeMinor = input.feeMinor ?? 0;
  const depositRequired = ctx.deposit.require && !isPublic
    ? ctx.deposit.amountMinor
    : isPublic && ctx.deposit.require
      ? Math.min(ctx.deposit.amountMinor, feeMinor)
      : 0;

  const status: Appointment['status'] =
    input.status ??
    (isPublic && ctx.deposit.require && ctx.deposit.amountMinor > 0 && !ctx.booking.autoConfirmWithoutDeposit
      ? 'scheduled'
      : 'confirmed');

  const holdExpiresAt =
    isPublic && status === 'scheduled'
      ? toIso(addMinutes(new Date(now), ctx.deposit.holdMinutes))
      : null;

  const id = createId('apt');
  const token = createToken(18);
  const values = {
    id,
    clinic_id: clinicId,
    patient_id: nullable(input.patientId),
    doctor_id: nullable(input.doctorId),
    starts_at: startsAt,
    ends_at: endsAt,
    timezone: ctx.timeZone,
    status,
    reason: nullable(input.reason),
    notes: nullable(input.notes),
    visit_type: input.visitType ?? 'consultation',
    source: input.source ?? (isPublic ? 'public_booking' : 'staff'),
    is_public_booking: bit(isPublic),
    hold_expires_at: holdExpiresAt,
    deposit_required_minor: depositRequired,
    deposit_paid_minor: 0,
    fee_minor: feeMinor,
    paid_minor: 0,
    cancelled_at: null,
    cancelled_by: null,
    cancellation_reason: null,
    checked_in_at: null,
    completed_at: null,
    rescheduled_from_id: null,
    confirmation_token: token,
    created_by: nullable(input.createdBy),
    patient_name: input.patientName,
    patient_phone: input.patientPhone,
    specialty: input.specialty ?? 'general_medicine',
    doctor_name: nullable(input.doctorName),
    created_at: now,
    updated_at: now,
  };

  // One transaction for the check and the write. A rejection from
  // validateBooking aborts before any row exists.
  const run = db.transaction((): Appointment => {
    const existing = tenant
      .all<Row>('appointments', 'starts_at < ? AND ends_at > ?', [endsAt, startsAt])
      .map(toAppointment);

    const check = validateBooking(
      { startsAt, endsAt, durationMinutes: duration, doctorId: input.doctorId ?? null, isPublicBooking: isPublic },
      {
        schedule: ctx.schedule,
        timeZone: ctx.timeZone,
        appointments: existing,
        now,
        doctorId: input.doctorId ?? null,
        booking: {
          minNoticeHours: ctx.booking.minNoticeHours,
          maxAdvanceDays: ctx.booking.maxAdvanceDays,
          maxDailyAppointments: ctx.booking.maxDailyAppointments,
        },
      },
    );

    if (!check.ok) {
      throw ApiError.conflict(rejectionMessage(check.reason), { reason: check.reason });
    }

    tenant.insert('appointments', values);
    const row = tenant.get<Row>('appointments', id);
    if (!row) throw new Error('Appointment insert did not persist.');
    return toAppointment(row);
  });

  const appointment = run();

  // Reminders are planned *after* the booking commits, in the caller's own
  // transaction scope. Doing it inside `run()` would mix reminder writes into
  // the overlap-check transaction, and a reminder failure would then roll back a
  // booking the patient has already been told is confirmed.
  //
  // `quiet` bookings (WhatsApp drafts awaiting staff confirmation) schedule
  // nothing: the confirm action does both explicitly. A reminder for a booking
  // nobody confirmed would message the patient about an appointment that may
  // never happen.
  if (!input.quiet) {
    scheduleAppointmentReminders(tenant, clinicId, appointment.id, { now });
    queueBookingConfirmation(tenant, clinicId, appointment, now);
  }

  return appointment;
}

function rejectionMessage(reason: string): string {
  switch (reason) {
    case 'outside_working_hours':
      return 'The clinic is closed at that time.';
    case 'overlaps_existing':
      return 'That time is already booked.';
    case 'breaks_or_blocked':
      return 'The clinic is on a break or closed for that period.';
    case 'insufficient_notice':
      return 'That time is too soon; please choose a later slot.';
    case 'too_far_in_future':
      return 'That time is too far ahead; please choose an earlier date.';
    case 'daily_limit_reached':
      return 'The clinic has reached its daily appointment limit for that day.';
    case 'holiday':
      return 'The clinic is closed on that date.';
    case 'invalid_duration':
      return 'That visit length is not allowed.';
    default:
      return 'That time is not available.';
  }
}

export type UpdateField =
  | 'status'
  | 'reason'
  | 'notes'
  | 'doctorId'
  | 'doctorName'
  | 'startsAt'
  | 'durationMinutes';

export function updateAppointment(
  tenant: TenantHandle,
  id: string,
  patch: Partial<Record<UpdateField, string | number | null>>,
  actorId: string | null,
  now = new Date().toISOString(),
): Appointment {
  const existing = toAppointment(tenant.require<Row>('appointments', id));
  const values: Record<string, string | number | null> = { updated_at: now };

  if (patch.status !== undefined) {
    const status = String(patch.status);
    values['status'] = status;
    if (status === 'checked_in') values['checked_in_at'] = now;
    if (status === 'completed') values['completed_at'] = now;
    if (status === 'cancelled') {
      values['cancelled_at'] = now;
      values['cancelled_by'] = actorId;
    }
  }
  if (patch.reason !== undefined) values['reason'] = nullable(patch.reason as string | null);
  if (patch.notes !== undefined) values['notes'] = nullable(patch.notes as string | null);
  if (patch.doctorId !== undefined) values['doctor_id'] = nullable(patch.doctorId as string | null);
  if (patch.doctorName !== undefined) values['doctor_name'] = nullable(patch.doctorName as string | null);

  if (patch.startsAt !== undefined || patch.durationMinutes !== undefined) {
    const startsAt = String(patch.startsAt ?? existing.startsAt);
    // Falling back to the stored span keeps a partial patch from silently
    // resizing the appointment to a default length.
    const duration =
      patch.durationMinutes !== undefined
        ? Number(patch.durationMinutes)
        : (Date.parse(existing.endsAt) - Date.parse(existing.startsAt)) / 60000;
    values['starts_at'] = startsAt;
    values['ends_at'] = toIso(addMinutes(new Date(startsAt), duration));
  }

  tenant.update('appointments', id, values);
  return toAppointment(tenant.require<Row>('appointments', id));
}

/**
 * Reschedule an appointment to a new time, keeping the same row (threads and
 * history stay linked) and rebuilding the reminder plan for the new time.
 *
 * The new slot goes through the exact same `validateBooking` check as a fresh
 * booking - same working hours, same overlap rules - except the appointment
 * itself is excluded from the overlap set. Anything else is a 409 with the
 * specific reason, so the UI (which only offers free slots) and the API can
 * never disagree about what is bookable.
 */
export function rescheduleAppointment(
  db: Db,
  tenant: TenantHandle,
  clinicId: string,
  ctx: BookingContext,
  id: string,
  input: { startsAt: string; reason: string; actorId: string | null },
  now = new Date().toISOString(),
): { appointment: Appointment; oldStartsAt: string } {
  const existing = toAppointment(tenant.require<Row>('appointments', id));
  if (existing.status === 'completed' || existing.status === 'cancelled' || existing.status === 'rescheduled') {
    throw ApiError.conflict(`Cannot reschedule an appointment that is "${existing.status}".`);
  }

  const duration = Math.max(5, Math.round((Date.parse(existing.endsAt) - Date.parse(existing.startsAt)) / 60000));
  const startsAt = input.startsAt;
  const endsAt = toIso(addMinutes(new Date(startsAt), duration));

  const run = db.transaction((): { appointment: Appointment; oldStartsAt: string } => {
    const overlapping = tenant
      .all<Row>('appointments', 'starts_at < ? AND ends_at > ?', [endsAt, startsAt])
      .map(toAppointment)
      .filter((a) => a.id !== id);

    const check = validateBooking(
      { startsAt, endsAt, durationMinutes: duration, doctorId: existing.doctorId, isPublicBooking: false },
      {
        schedule: ctx.schedule,
        timeZone: ctx.timeZone,
        appointments: overlapping,
        now,
        doctorId: existing.doctorId,
        booking: {
          minNoticeHours: ctx.booking.minNoticeHours,
          maxAdvanceDays: ctx.booking.maxAdvanceDays,
          maxDailyAppointments: ctx.booking.maxDailyAppointments,
        },
      },
    );
    if (!check.ok) {
      throw ApiError.conflict(rejectionMessage(check.reason), { reason: check.reason });
    }

    tenant.update('appointments', id, {
      starts_at: startsAt,
      ends_at: endsAt,
      cancellation_reason: null,
      updated_at: now,
    });
    const row = tenant.require<Row>('appointments', id);
    return { appointment: toAppointment(row), oldStartsAt: existing.startsAt };
  });

  const result = run();

  // Reminders are replanned after the move commits (same rule as booking: a
  // reminder failure must never roll back a move the patient already sees).
  // Pending rows for the old time are cancelled first inside the planner.
  scheduleAppointmentReminders(tenant, clinicId, id, { now });

  return result;
}

/** Cancel an appointment and free the slot. */
export function cancelAppointment(
  tenant: TenantHandle,
  id: string,
  actorId: string | null,
  reason: string | null,
  now = new Date().toISOString(),
): Appointment {
  tenant.update('appointments', id, {
    status: 'cancelled',
    cancelled_at: now,
    cancelled_by: actorId,
    cancellation_reason: reason,
    // Releasing the hold matters for public bookings: a cancelled slot must
    // become bookable again, not stay reserved.
    hold_expires_at: null,
    updated_at: now,
  });
  return toAppointment(tenant.require<Row>('appointments', id));
}

/** Expire public holds that were never paid for. Returns the freed ids. */
export function releaseExpiredHolds(tenant: TenantHandle, now = new Date().toISOString()): string[] {
  const rows = tenant.all<Row>(
    'appointments',
    "status = 'scheduled' AND is_public_booking = 1 AND hold_expires_at IS NOT NULL AND hold_expires_at <= ?",
    [now],
  );
  const freed: string[] = [];
  const update = (row: Row): void => {
    tenant.update('appointments', String(row['id']), {
      status: 'cancelled',
      cancelled_at: now,
      cancelled_by: null,
      cancellation_reason: 'Booking hold expired without payment.',
      hold_expires_at: null,
      updated_at: now,
    });
    freed.push(String(row['id']));
  };
  rows.forEach(update);
  return freed;
}
