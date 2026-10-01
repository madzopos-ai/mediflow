/**
 * Deterministic, collision-resistant id and token helpers.
 *
 * Ids are time-sortable (prefixed base36 timestamp + randomness) which makes
 * IndexedDB cursors and delta sync stable without extra bookkeeping.
 */

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/**
 * Minimal structural type for the Web Crypto random source. Declared locally
 * rather than relying on `lib.dom` so this package compiles identically for the
 * Node API and the browser PWA, and so it also works in insecure contexts
 * (plain-HTTP LAN installs) where `crypto.subtle` is unavailable.
 */
interface RandomSource {
  getRandomValues(array: Uint8Array): Uint8Array;
}

function getRandomSource(): RandomSource | null {
  const g = (globalThis as { crypto?: Partial<RandomSource> }).crypto;
  return g && typeof g.getRandomValues === 'function' ? (g as RandomSource) : null;
}

function randomBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  const g = getRandomSource();
  if (g) {
    g.getRandomValues(out);
    return out;
  }
  for (let i = 0; i < length; i += 1) {
    out[i] = Math.floor(Math.random() * 256);
  }
  return out;
}

/** Cryptographically random hex string. */
export function randomHex(bytes = 16): string {
  const buf = randomBytes(bytes);
  let out = '';
  for (const b of buf) out += b.toString(16).padStart(2, '0');
  return out;
}

function encodeBase36(num: number, width: number): string {
  let out = '';
  let n = Math.max(0, Math.floor(num));
  while (n > 0) {
    out = ALPHABET[n % 36] + out;
    n = Math.floor(n / 36);
  }
  return out.padStart(width, '0');
}

/**
 * Time-sortable id: `<prefix>_<base36 time><base36 random>`.
 * Example: `pat_lq3k9x2_8f2a1b0c4d`.
 */
export function createId(prefix: string, now: Date = new Date()): string {
  const time = encodeBase36(now.getTime(), 9);
  const rnd = encodeBase36(Number.parseInt(randomHex(8), 16), 10);
  return `${prefix}_${time}${rnd}`;
}

export const ID_PREFIX = {
  clinic: 'cln',
  user: 'usr',
  member: 'mbr',
  patient: 'pat',
  appointment: 'apt',
  reminder: 'rem',
  waitlist: 'wl',
  outbox: 'obx',
  thread: 'thr',
  message: 'msg',
  diagnosis: 'dx',
  prescription: 'rx',
  document: 'doc',
  vital: 'vit',
  protocol: 'prt',
  followUp: 'fu',
  alert: 'alr',
  notification: 'ntf',
  ledger: 'ldg',
  invoice: 'inv',
  invoiceLine: 'iln',
  service: 'svc',
  voiceNote: 'vn',
  audit: 'aud',
  holiday: 'hol',
  session: 'ses',
  token: 'tok',
} as const;

/** URL-safe secret used for booking confirmations, public links, QR codes. */
export function createToken(bytes = 24): string {
  return randomHex(bytes);
}

/** Stable short hash used for dedupe keys (FNV-1a 64-bit-ish, hex). */
export function stableHash(input: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < input.length; i += 1) {
    const c = input.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 = (h2 + c) >>> 0;
    h2 = Math.imul(h2, 0x85ebca6b) >>> 0;
  }
  return `${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`;
}

/** URL-safe slug. Collisions are resolved by the caller. */
export function slugify(input: string, maxLength = 60): string {
  const base = input
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/g, '');
  return base || 'clinic';
}

/** Generate a readable MRN: PREFIX-000123 */
export function formatMrn(prefix: string, sequence: number, width = 6): string {
  return `${prefix.toUpperCase()}-${String(sequence).padStart(width, '0')}`;
}

/** Generate a sequential document number with a period suffix. */
export function formatDocumentNumber(prefix: string, sequence: number, year = new Date().getUTCFullYear()): string {
  return `${prefix}-${year}-${String(sequence).padStart(5, '0')}`;
}
