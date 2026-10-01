/**
 * Test helpers for schedule-dependent booking tests.
 *
 * The clinic enforces a minimum notice period, so a test cannot simply take the
 * first slot of today: it is usually inside that window. Picking a slot at least
 * `minLeadDays` out keeps a booking test from failing at 09:00 and passing at 18:00.
 */

export interface SlotDay {
  dateKey: string;
  slots: { startsAt: string; endsAt: string; localStart: string; localEnd: string }[];
}

export function flattenSlots(days: SlotDay[]): string[] {
  const out: string[] = [];
  for (const day of days) {
    for (const slot of day.slots) out.push(slot.startsAt);
  }
  return out;
}

/** A bookable instant that is far enough ahead of the minimum notice period. */
export function pickBookableSlot(days: SlotDay[], minLeadDays = 2): string {
  const sorted = days.filter((d) => d.slots.length > 0);
  const chosen = sorted[Math.min(minLeadDays, Math.max(0, sorted.length - 1))];
  const start = chosen?.slots[0]?.startsAt;
  if (!start) throw new Error('the seeded schedule offered no bookable slot');
  return start;
}
