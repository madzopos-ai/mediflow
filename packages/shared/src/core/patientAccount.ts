/**
 * Patient account identity for Firebase-native deployments (no API server).
 *
 * There is no backend to check a PIN, so the account id itself is the
 * credential: `id = iterated-SHA-256("mediflow-patient:v1:" + phone + ":" + pin)`.
 * Whoever knows the phone + PIN re-derives the id on any device; whoever does
 * not know them faces a 256-bit preimage search. Rules therefore allow
 * single-document get/create/update/delete to any signed-in user (anonymous
 * included) and forbid list queries entirely - the id is never enumerable.
 *
 * Key stretching (many SHA-256 rounds, ~100ms client-side) multiplies the
 * cost of PIN guessing: a 6-digit PIN space stays impractical to sweep.
 * This is honest capability security, not a password database: it protects a
 * clinic app, not a bank. PINs are never stored - only the id derived from
 * them - so a database leak reveals no credentials.
 */

export const PATIENT_ID_VERSION = 'mediflow-patient:v1';
export const PATIENT_ID_ROUNDS = 20000;
export const PATIENT_PIN_LENGTH = 6;

// The shared package builds without the DOM lib: minimal ambient shapes for
// the WebCrypto + TextEncoder APIs used here (present in browsers and Node).
declare const crypto: {
  subtle: { digest(algorithm: string, data: Uint8Array): Promise<ArrayBuffer> };
  getRandomValues<T extends Uint8Array>(array: T): T;
};
declare class TextEncoder {
  encode(input: string): Uint8Array;
}

/** Canonical phone form: digits only with a leading `+`. */
export function canonicalPatientPhone(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15) {
    throw new Error('Phone number must have 7-15 digits.');
  }
  return `+${digits}`;
}

export function assertPatientPin(pin: string): void {
  if (!new RegExp(`^\\d{${PATIENT_PIN_LENGTH},12}$`).test(pin.trim())) {
    throw new Error(`PIN must be ${PATIENT_PIN_LENGTH}-12 digits.`);
  }
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Deterministic, device-independent account id from phone + PIN. */
export async function derivePatientAccountId(phone: string, pin: string): Promise<string> {
  const canonical = canonicalPatientPhone(phone);
  assertPatientPin(pin);
  const material = `${PATIENT_ID_VERSION}:${canonical}:${pin.trim()}`;
  let hex = await sha256Hex(material);
  for (let round = 1; round < PATIENT_ID_ROUNDS; round += 1) {
    hex = await sha256Hex(`${hex}:${round}`);
  }
  return hex;
}

const TICKET_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function randomFromAlphabet(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => TICKET_ALPHABET[b % TICKET_ALPHABET.length]).join('');
}

export interface PatientLinkTicket {
  /** Short code the patient reads out; doubles as the ticket doc id. */
  ticket: string;
  /** Secret the clinic verifies before linking. */
  secret: string;
}

/**
 * One-time linking ticket (valid ~10 minutes, enforced by the reader).
 * The patient creates `linkTickets/{ticket}`; staff reads it by id, verifies
 * the secret against the account doc, links both sides, deletes the ticket.
 * Single-doc gets only - nothing enumerable - so no list rule is needed.
 */
export function createLinkTicket(): PatientLinkTicket {
  return { ticket: randomFromAlphabet(6), secret: randomFromAlphabet(16) };
}
