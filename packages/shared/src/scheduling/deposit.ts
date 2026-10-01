/**
 * Deposit policy.
 *
 * Deposits are the mechanism that stops a public booking flood from filling a
 * clinic's calendar with numbers that never answer, so the rules here decide
 * whether an appointment is confirmed or merely held.
 *
 * Kept in minor units (integers) throughout: floats lose cents.
 */

import type { Appointment, BookingPolicy } from '../domain/types.js';
import { formatMoney } from '../core/money.js';

export type DepositExemptionReason =
  | 'clinic_policy_off'
  | 'staff_booking'
  | 'auto_confirm'
  | 'patient_exempt'
  | 'zero_fee'
  | 'waived_by_staff';

export interface DepositDecision {
  requiredMinor: number;
  paidMinor: number;
  outstandingMinor: number;
  /** True when the appointment is confirmed rather than provisional. */
  satisfied: boolean;
  exempt: boolean;
  exemptionReason: DepositExemptionReason | null;
  /** What the UI should say next. */
  action: 'confirm' | 'await_deposit' | 'release_hold' | 'none';
}

export interface DepositContext {
  booking: BookingPolicy;
  /** Clinic-level rule from ClinicSettings. */
  clinicRequiresDeposit: boolean;
  /** Per-patient override. */
  patientExempt?: boolean;
  feeMinor: number;
  /** Fixed deposit for a visit type, when the clinic uses one. */
  defaultDepositMinor?: number;
  isPublicBooking: boolean;
  source: Appointment['source'];
  /** Deposit the staff member waived, if any. */
  waivedMinor?: number;
}

/**
 * Decide the deposit requirement for a booking.
 *
 * A staff booking is never held for a deposit: a receptionist confirming an
 * appointment on the phone should not be told to wait for a payment webhook.
 */
export function decideDeposit(context: DepositContext): DepositDecision {
  const paid = Math.max(0, context.waivedMinor ?? 0);

  const exemptFor = (): DepositExemptionReason | null => {
    if (!context.clinicRequiresDeposit) return 'clinic_policy_off';
    if (!context.isPublicBooking) return 'staff_booking';
    if (context.booking.autoConfirmWithoutDeposit) return 'auto_confirm';
    if (context.patientExempt) return 'patient_exempt';
    if (context.feeMinor <= 0) return 'zero_fee';
    if (paid >= context.feeMinor) return 'waived_by_staff';
    return null;
  };

  const reason = exemptFor();
  if (reason) {
    return {
      requiredMinor: 0,
      paidMinor: paid,
      outstandingMinor: 0,
      satisfied: true,
      exempt: true,
      exemptionReason: reason,
      action: 'confirm',
    };
  }

  const required = Math.max(0, context.defaultDepositMinor ?? Math.round(context.feeMinor / 2));
  const outstanding = Math.max(0, required - paid);

  return {
    requiredMinor: required,
    paidMinor: paid,
    outstandingMinor: outstanding,
    satisfied: outstanding === 0,
    exempt: false,
    exemptionReason: null,
    action: outstanding === 0 ? 'confirm' : 'await_deposit',
  };
}

/** Whether a held public booking has lapsed and should free the slot. */
export function isHoldExpired(appointment: Appointment, now: string = new Date().toISOString()): boolean {
  if (appointment.holdExpiresAt === null) return false;
  if (appointment.status === 'confirmed' || appointment.status === 'checked_in' || appointment.status === 'completed') {
    return false;
  }
  return appointment.holdExpiresAt <= now;
}

/** Human-readable explanation for the finance screen. */
export function describeDeposit(decision: DepositDecision, currency: string): string {
  if (decision.exempt) {
    const reasons: Record<DepositExemptionReason, string> = {
      clinic_policy_off: 'Deposits disabled for this clinic',
      staff_booking: 'Staff booking - deposit not required',
      auto_confirm: 'Clinic auto-confirms without deposit',
      patient_exempt: 'Patient is exempt from deposits',
      zero_fee: 'No fee for this visit',
      waived_by_staff: 'Deposit waived by staff',
    };
    return reasons[decision.exemptionReason ?? 'clinic_policy_off'];
  }
  if (decision.satisfied) return `Deposit settled (${formatMoney(decision.paidMinor, currency)})`;
  return `${formatMoney(decision.outstandingMinor, currency)} outstanding of ${formatMoney(decision.requiredMinor, currency)}`;
}
