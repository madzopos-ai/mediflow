/**
 * Smart waitlist and slot filling.
 *
 * When an appointment is cancelled the slot is offered to the highest-ranked
 * waiting patient who can actually attend it. "Actually attend" is the part
 * that matters: offering a 07:00 slot to someone whose stated window is
 * afternoons produces no booking and burns the offer, so a mismatch is
 * discarded in favour of the next candidate rather than accepted and dropped.
 *
 * Ranking is explicit and deterministic. An LLM deciding who gets a cancelled
 * dialysis slot would be indefensible in a clinical setting.
 */

import type { Appointment, WaitlistEntry } from '../domain/types.js';
import { findAvailableSlots, type Slot } from './slots.js';
import { addMinutes, toIso } from '../core/time.js';

/** Default lifetime of a waitlist offer. */
export const OFFER_TTL_MINUTES = 120;

/**
 * Higher is better.
 *
 * Clinical urgency dominates, then how long the patient has waited, then
 * whether the freed slot is one they specifically asked for. Staleness is
 * capped so that a patient who joined a year ago does not permanently outrank
 * an urgent case.
 */
export function waitlistScore(entry: WaitlistEntry, slot: Slot, now: string = new Date().toISOString()): number {
  const priority = entry.priority;
  const waitingDays = entry.createdAt
    ? Math.max(0, Math.floor((new Date(now).getTime() - new Date(entry.createdAt).getTime()) / 86_400_000))
    : 0;
  // Waiting time helps up to 20 points, then saturates.
  const waiting = Math.min(20, waitingDays * 0.5);
  const exactDate = entry.preferredDateFrom === slot.dateKey ? 6 : 0;
  const inWindow = entry.preferredDateTo !== null && slot.dateKey >= (entry.preferredDateFrom ?? slot.dateKey) && slot.dateKey <= entry.preferredDateTo ? 4 : 0;
  const sameDoctor = entry.doctorId !== null ? 0 : 2;
  // A patient who has already been offered and ignored this slot ranks lower.
  const offerPenalty = entry.lastOfferedAt !== null && entry.lastOfferedAt > (entry.createdAt ?? '') ? 3 : 0;

  return priority * 100 + waiting + exactDate + inWindow + sameDoctor - offerPenalty;
}

export type WaitlistMismatch = 'outside_date_range' | 'outside_time_window' | 'wrong_doctor' | 'already_booked' | 'expired';

export interface WaitlistMatch {
  entry: WaitlistEntry;
  score: number;
}

export interface MatchOptions {
  now?: string;
  /** Freed slot being offered. */
  slot: Slot;
  /** Excludes these patient ids, e.g. the patient who just cancelled. */
  excludePatientIds?: readonly string[];
  /** Patient ids with a conflicting appointment in the same window. */
  busyPatientIds?: readonly string[];
}

/**
 * Does this entry actually suit the slot?
 *
 * Returns the reason on mismatch so the caller can record why a candidate was
 * passed over, which is what makes the queue auditable.
 */
export function mismatchReason(entry: WaitlistEntry, slot: Slot, options: MatchOptions): WaitlistMismatch | null {
  if (entry.status !== 'waiting') return 'expired';
  if (options.excludePatientIds?.includes(entry.patientId)) return 'already_booked';
  if (options.busyPatientIds?.includes(entry.patientId)) return 'already_booked';

  if (entry.preferredDateFrom !== null && slot.dateKey < entry.preferredDateFrom) return 'outside_date_range';
  if (entry.preferredDateTo !== null && slot.dateKey > entry.preferredDateTo) return 'outside_date_range';

  if (entry.preferredTimeWindows.length > 0) {
    const inside = entry.preferredTimeWindows.some((w) => slot.localStart >= w.start && slot.localEnd <= w.end);
    if (!inside) return 'outside_time_window';
  }
  return null;
}

export interface SlotFillerInput {
  entry: WaitlistEntry;
  slot: Slot;
  now?: string;
  ttlMinutes?: number;
  doctorId?: string | null;
}

export interface WaitlistOffer {
  entryId: string;
  patientId: string;
  clinicId: string;
  slotStart: string;
  slotEnd: string;
  expiresAt: string;
  dedupeKey: string;
}

/**
 * Build the offer for a matched entry.
 *
 * `dedupeKey` includes the slot start so a retry of the same fill cannot send a
 * second offer for a slot already offered.
 */
export function buildOffer(input: SlotFillerInput): WaitlistOffer {
  const now = input.now ?? new Date().toISOString();
  const ttl = input.ttlMinutes ?? OFFER_TTL_MINUTES;
  return {
    entryId: input.entry.id,
    patientId: input.entry.patientId,
    clinicId: input.entry.clinicId,
    slotStart: input.slot.startsAt,
    slotEnd: input.slot.endsAt,
    expiresAt: toIso(addMinutes(new Date(now), ttl)),
    dedupeKey: `waitlist_offer:${input.entry.id}:${input.slot.startsAt}`,
  };
}

export interface RankedCandidates {
  matches: WaitlistMatch[];
  /** Entries that could not attend, with the reason. */
  rejected: { entry: WaitlistEntry; reason: WaitlistMismatch; score: number }[];
}

/**
 * Rank the candidates for a freed slot, best first.
 *
 * Rejected candidates are returned rather than silently dropped so the clinic
 * can see why a patient was not offered a slot.
 */
export function rankCandidates(entries: readonly WaitlistEntry[], options: MatchOptions): RankedCandidates {
  const matches: WaitlistMatch[] = [];
  const rejected: RankedCandidates['rejected'] = [];

  for (const entry of entries) {
    const reason = mismatchReason(entry, options.slot, options);
    const score = waitlistScore(entry, options.slot, options.now);
    if (reason) rejected.push({ entry, reason, score });
    else matches.push({ entry, score });
  }

  matches.sort((a, b) => b.score - a.score || a.entry.createdAt.localeCompare(b.entry.createdAt));
  rejected.sort((a, b) => b.score - a.score);
  return { matches, rejected };
}

export interface FillFreedSlotInput {
  clinicId: string;
  slot: Slot;
  waitlist: readonly WaitlistEntry[];
  schedule: Parameters<typeof findAvailableSlots>[0]['schedule'];
  timeZone: string;
  appointments: readonly Appointment[];
  /** Offer only this many candidates, so one patient cannot hoard the queue. */
  batchSize?: number;
  ttlMinutes?: number;
  now?: string;
  excludePatientIds?: readonly string[];
}

export interface FillFreedSlotResult {
  offers: WaitlistOffer[];
  /** The next candidate after the ones offered, for manual follow-up. */
  nextInLine: WaitlistEntry | null;
  rejected: RankedCandidates['rejected'];
}

/**
 * Offer a freed slot down the queue.
 *
 * Only the first candidate is offered by default: offering the same slot to
 * three patients produces three simultaneous "yes" replies and one of them
 * loses the slot, which is worse than a short wait.
 */
export function fillFreedSlot(input: FillFreedSlotInput): FillFreedSlotResult {
  const now = input.now ?? new Date().toISOString();
  const busyPatientIds = input.appointments
    .filter((a) => new Date(a.startsAt) < new Date(input.slot.endsAt) && new Date(a.endsAt) > new Date(input.slot.startsAt))
    .map((a) => a.patientId);

  const { matches, rejected } = rankCandidates(input.waitlist, {
    slot: input.slot,
    now,
    excludePatientIds: input.excludePatientIds,
    busyPatientIds,
  });

  const batch = input.batchSize ?? 1;
  const offers = matches.slice(0, batch).map((match) =>
    buildOffer({ entry: match.entry, slot: input.slot, now, ttlMinutes: input.ttlMinutes }),
  );

  return {
    offers,
    nextInLine: matches[batch]?.entry ?? null,
    rejected,
  };
}

/** Apply an offer to a waitlist entry. */
export function markOffered(entry: WaitlistEntry, offer: WaitlistOffer, now: string): WaitlistEntry {
  return {
    ...entry,
    status: 'offered',
    offeredSlotStart: offer.slotStart,
    offeredSlotEnd: offer.slotEnd,
    offerExpiresAt: offer.expiresAt,
    lastOfferedAt: now,
    offers: entry.offers + 1,
    updatedAt: now,
  };
}

export function markBooked(entry: WaitlistEntry, appointmentId: string, now: string): WaitlistEntry {
  return {
    ...entry,
    status: 'booked',
    offeredAppointmentId: appointmentId,
    offerExpiresAt: null,
    updatedAt: now,
  };
}

export function markDeclined(entry: WaitlistEntry, now: string): WaitlistEntry {
  return {
    ...entry,
    status: 'waiting',
    offeredSlotStart: null,
    offeredSlotEnd: null,
    offerExpiresAt: null,
    updatedAt: now,
  };
}

export function markCancelled(entry: WaitlistEntry, now: string): WaitlistEntry {
  return { ...entry, status: 'cancelled', offerExpiresAt: null, updatedAt: now };
}

/** Offers whose window has closed, so the slot can move to the next patient. */
export function expiredOffers(entries: readonly WaitlistEntry[], now: string): WaitlistEntry[] {
  return entries.filter(
    (e) => e.status === 'offered' && e.offerExpiresAt !== null && e.offerExpiresAt <= now,
  );
}

export interface WaitlistStats {
  waiting: number;
  offered: number;
  booked: number;
  expired: number;
  cancelled: number;
  /** Slots filled from the waitlist, for the dashboard. */
  filledFromWaitlist: number;
  averageWaitDays: number;
}

export function summariseWaitlist(entries: readonly WaitlistEntry[], now: string = new Date().toISOString()): WaitlistStats {
  const stats: WaitlistStats = {
    waiting: 0,
    offered: 0,
    booked: 0,
    expired: 0,
    cancelled: 0,
    filledFromWaitlist: 0,
    averageWaitDays: 0,
  };
  const waits: number[] = [];

  for (const entry of entries) {
    stats[entry.status] += 1;
    if (entry.status === 'booked') {
      stats.filledFromWaitlist += 1;
      if (entry.createdAt) {
        waits.push(Math.max(0, Math.floor((new Date(now).getTime() - new Date(entry.createdAt).getTime()) / 86_400_000)));
      }
    }
  }
  stats.averageWaitDays = waits.length
    ? Math.round((waits.reduce((a, b) => a + b, 0) / waits.length) * 10) / 10
    : 0;
  return stats;
}
