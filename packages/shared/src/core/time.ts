/**
 * Timezone-safe date helpers.
 *
 * The clinic timezone is authoritative. Slot generation, "today" boundaries and
 * reminder scheduling must all be computed in the clinic's local calendar, then
 * persisted as absolute UTC ISO strings.
 */

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

export const WEEKDAY_LABELS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

export const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

/** "HH:mm" -> minutes since midnight. Returns null for malformed input. */
export function parseTimeToMinutes(time: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return null;
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return hours * 60 + minutes;
}

export function minutesToTime(minutes: number): string {
  const clamped = Math.max(0, Math.min(24 * 60 - 1, Math.round(minutes)));
  const h = Math.floor(clamped / 60);
  const m = clamped % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export function isValidTime(time: string): boolean {
  return parseTimeToMinutes(time) !== null;
}

/** yyyy-mm-dd in a specific IANA timezone. */
export function dateKeyInTz(date: Date, timeZone: string): string {
  // `en-CA` yields the ISO calendar date, which is exactly what we need.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

/** Convert a wall-clock date+time in a timezone to an absolute UTC Date. */
export function zonedTimeToUtc(dateKey: string, time: string, timeZone: string): Date {
  const minutes = parseTimeToMinutes(time);
  if (minutes === null) {
    throw new RangeError(`invalid time: ${time}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) {
    throw new RangeError(`invalid date key: ${dateKey}`);
  }
  const [y, m, d] = dateKey.split('-').map((p) => Number(p)) as [number, number, number];
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  // Two passes converge for all real-world offsets including :30/:45 zones.
  let guess = Date.UTC(y, m - 1, d, hours, mins, 0, 0);
  for (let i = 0; i < 2; i += 1) {
    const offset = tzOffsetMs(new Date(guess), timeZone);
    guess = Date.UTC(y, m - 1, d, hours, mins, 0, 0) - offset;
  }
  return new Date(guess);
}

/** Offset of a timezone from UTC at a given instant, in milliseconds. */
export function tzOffsetMs(instant: Date, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = dtf.formatToParts(instant);
  const map: Record<string, number> = {};
  for (const p of parts) {
    if (p.type !== 'literal') {
      map[p.type] = Number(p.value);
    }
  }
  const hour = map.hour === 24 ? 0 : (map.hour ?? 0);
  const asUtc = Date.UTC(map.year ?? 1970, (map.month ?? 1) - 1, map.day ?? 1, hour, map.minute ?? 0, map.second ?? 0);
  return asUtc - instant.getTime();
}

/** Weekday index (0=Sunday) for a yyyy-mm-dd date. */
export function weekdayOfDateKey(dateKey: string): number {
  const [y, m, d] = dateKey.split('-').map((p) => Number(p)) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function addDaysToDateKey(dateKey: string, days: number): string {
  const [y, m, d] = dateKey.split('-').map((p) => Number(p)) as [number, number, number];
  const base = Date.UTC(y, m - 1, d);
  return new Date(base + days * DAY_MS).toISOString().slice(0, 10);
}

export function dateKeyRange(fromDateKey: string, toDateKey: string): string[] {
  const out: string[] = [];
  let cursor = fromDateKey;
  // Guard against pathological input.
  for (let i = 0; i < 1000; i += 1) {
    out.push(cursor);
    if (cursor === toDateKey) break;
    cursor = addDaysToDateKey(cursor, 1);
    if (cursor > toDateKey) break;
  }
  return out;
}

/** Whole days between two date keys (b - a). */
export function diffDaysBetweenDateKeys(a: string, b: string): number {
  const [ay, am, ad] = a.split('-').map((p) => Number(p)) as [number, number, number];
  const [by, bm, bd] = b.split('-').map((p) => Number(p)) as [number, number, number];
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / DAY_MS);
}

export function startOfDayUtcKey(dateKey: string): string {
  return `${dateKey}T00:00:00.000Z`;
}

/** Local Y/M/D/H/m parts of an instant in a timezone. */
export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
}

export function zonedParts(instant: Date, timeZone: string): ZonedParts {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
  });
  const parts = dtf.formatToParts(instant);
  const map: Record<string, string> = {};
  for (const p of parts) {
    if (p.type !== 'literal') map[p.type] = p.value;
  }
  const weekdayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const hour = Number(map.hour) === 24 ? 0 : Number(map.hour);
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour,
    minute: Number(map.minute),
    weekday: weekdayMap[map.weekday ?? 'Sun'] ?? 0,
  };
}

/** The yyyy-mm-dd of "today" for the clinic. */
export function todayInTz(timeZone: string, now: Date = new Date()): string {
  return dateKeyInTz(now, timeZone);
}

/** Does `dateKey` fall inside [from, to] inclusive? */
export function isDateKeyWithin(dateKey: string, from: string, to: string): boolean {
  return dateKey >= from && dateKey <= to;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function toIso(value: Date | string | number): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * MINUTE_MS);
}

export function addHours(date: Date, hours: number): Date {
  return new Date(date.getTime() + hours * HOUR_MS);
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}

export function minutesBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / MINUTE_MS);
}

export function hoursBetween(a: Date, b: Date): number {
  return (b.getTime() - a.getTime()) / HOUR_MS;
}

export function isSameUtcDate(a: Date, b: Date): boolean {
  return a.toISOString().slice(0, 10) === b.toISOString().slice(0, 10);
}

/** Age in whole years from a yyyy-mm-dd DOB, as of a reference date. */
export function ageFromDob(dobDateKey: string, referenceDateKey: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dobDateKey) || !/^\d{4}-\d{2}-\d{2}$/.test(referenceDateKey)) {
    return null;
  }
  const [by, bm, bd] = dobDateKey.split('-').map((p) => Number(p)) as [number, number, number];
  const [ry, rm, rd] = referenceDateKey.split('-').map((p) => Number(p)) as [number, number, number];
  let age = ry - by;
  if (rm < bm || (rm === bm && rd < bd)) age -= 1;
  return age >= 0 && age < 130 ? age : null;
}

export function bmiFrom(heightCm: number | null, weightKg: number | null): number | null {
  if (!heightCm || !weightKg || heightCm <= 0) return null;
  const m = heightCm / 100;
  const value = weightKg / (m * m);
  return Math.round(value * 10) / 10;
}

/** Normalize a loosely-formatted phone number to a comparable E.164 string. */
export function normalizePhone(input: string, defaultDialCode = ''): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  const hasPlus = trimmed.startsWith('+') || trimmed.startsWith('00');
  const digits = trimmed.replace(/\D/g, '');
  if (!digits) return null;
  if (hasPlus) return `+${digits}`;
  if (defaultDialCode) {
    const code = defaultDialCode.replace(/\D/g, '');
    if (digits.startsWith(code)) return `+${digits}`;
    return `+${code}${digits}`;
  }
  return `+${digits}`;
}

export function isValidE164(phone: string): boolean {
  return /^\+[1-9]\d{6,14}$/.test(phone);
}

/** Coarse display helper that always resolves to a string. */
export function formatDateTime(iso: string | null | undefined, timeZone = 'UTC', locale = 'en-US'): string {
  if (!iso) return '—';
  try {
    return new Intl.DateTimeFormat(locale, {
      timeZone,
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(iso));
  } catch {
    return new Date(iso).toISOString();
  }
}

export function formatTime(iso: string | null | undefined, timeZone = 'UTC', locale = 'en-US'): string {
  if (!iso) return '—';
  try {
    return new Intl.DateTimeFormat(locale, {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(iso));
  } catch {
    return new Date(iso).toISOString().slice(11, 16);
  }
}

export function formatDate(iso: string | null | undefined, timeZone = 'UTC', locale = 'en-US'): string {
  if (!iso) return '—';
  try {
    return new Intl.DateTimeFormat(locale, { timeZone, dateStyle: 'medium' }).format(new Date(iso));
  } catch {
    return iso.slice(0, 10);
  }
}

export function relativeTime(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return '—';
  const diff = new Date(iso).getTime() - now.getTime();
  const abs = Math.abs(diff);
  const minute = Math.round(abs / MINUTE_MS);
  if (minute < 1) return 'just now';
  if (minute < 60) return diff > 0 ? `in ${minute}m` : `${minute}m ago`;
  const hour = Math.round(minute / 60);
  if (hour < 24) return diff > 0 ? `in ${hour}h` : `${hour}h ago`;
  const day = Math.round(hour / 24);
  if (day < 30) return diff > 0 ? `in ${day}d` : `${day}d ago`;
  const month = Math.round(day / 30);
  return diff > 0 ? `in ${month}mo` : `${month}mo ago`;
}
