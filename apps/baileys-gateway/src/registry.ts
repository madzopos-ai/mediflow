/**
 * Live session state for every clinic, for the web app to read.
 *
 * Pairing a WhatsApp number used to mean reading a pairing code out of the
 * gateway's stdout on Render, which is a terrible loop for a clinic that has
 * staff: the person who can see the code is rarely the person who owns the
 * phone. This registry is the in-memory bridge that lets the HTTP layer answer
 * "is this clinic paired, and what should I show them right now" without
 * reaching into the socket or the log.
 *
 * The registry holds derived display state only. No credential material is
 * stored here, and QR/pairing values are deliberately short-lived: they are the
 * live pairing material for a WhatsApp account and are therefore never written
 * to disk or logged by this module.
 */

export type SessionState =
  /** Registered, but the socket has not reported anything yet. */
  | 'pending'
  | 'connecting'
  /** Socket is up and waiting to be paired (a QR is available). */
  | 'pairing'
  | 'connected'
  | 'disconnected'
  /** WhatsApp dropped the session; a human must re-pair. */
  | 'logged-out'
  | 'error';

export interface ClinicSession {
  clinicId: string;
  /** Masked for display, e.g. +9665xx xxx 001. Not needed to pair. */
  phoneMasked: string | null;
  state: SessionState;
  /** Raw Baileys QR string, or null when there is nothing to scan. */
  qr: string | null;
  qrUpdatedAt: string | null;
  pairingCode: string | null;
  pairingCodeUpdatedAt: string | null;
  /** True once the persisted session has credentials. */
  registered: boolean;
  connectedAt: string | null;
  lastError: string | null;
  updatedAt: string;
}

/** Callable handle to a live socket, used to fetch a pairing code on demand. */
export type PairingCodeRequester = (phoneNumber: string) => Promise<string>;

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Keeps a phone number present but not fully readable in status payloads.
 *
 * The web app shows which number a clinic is pairing, and staff need to
 * recognise their own line, but the full number is not needed for that and this
 * endpoint is not a place to hand out contact details.
 */
export function maskPhone(e164Digits: string): string {
  const digits = e164Digits.replace(/[^0-9]/g, '');
  if (digits.length <= 6) return `+${digits}`;
  // Keep the country code and the last three digits, mask everything between.
  // Three visible digits at each end is enough for a clinic to recognise their
  // own line without handing out a full contact number over HTTP.
  const head = digits.slice(0, 3);
  const tail = digits.slice(-3);
  const hidden = 'x'.repeat(digits.length - 6);
  return `+${head}${hidden.slice(0, Math.ceil(hidden.length / 2))} ${hidden.slice(Math.ceil(hidden.length / 2))} ${tail}`;
}

export class SessionRegistry {
  private readonly sessions = new Map<string, ClinicSession>();
  private readonly requesters = new Map<string, PairingCodeRequester>();
  /**
   * Real phone digits, kept out of the public session shape.
   *
   * Requesting a pairing code needs the actual number, but `phoneMasked` is all
   * any response should carry. Keeping the digits here means the HTTP layer
   * never has to reconstruct a number from a request or an env var, so there is
   * no path by which a caller can choose which phone gets linked.
   */
  private readonly phoneNumbers = new Map<string, string>();

  /**
   * Declares a clinic as configured.
   *
   * Called for every clinic before any socket work starts, so the UI can show a
   * clinic as `pending` even when its service-account key is missing and the
   * socket never comes up. Without this, a clinic would be invisible until it
   * connected, and a broken one would look like a typo in the UI.
   */
  declare(clinicId: string, phoneNumber: string | null): ClinicSession {
    const existing = this.sessions.get(clinicId);
    if (phoneNumber) this.phoneNumbers.set(clinicId, phoneNumber);
    if (existing) {
      existing.phoneMasked = phoneNumber ? maskPhone(phoneNumber) : existing.phoneMasked;
      existing.updatedAt = nowIso();
      return existing;
    }
    const session: ClinicSession = {
      clinicId,
      phoneMasked: phoneNumber ? maskPhone(phoneNumber) : null,
      state: 'pending',
      qr: null,
      qrUpdatedAt: null,
      pairingCode: null,
      pairingCodeUpdatedAt: null,
      registered: false,
      connectedAt: null,
      lastError: null,
      updatedAt: nowIso(),
    };
    this.sessions.set(clinicId, session);
    return session;
  }

  get(clinicId: string): ClinicSession | null {
    return this.sessions.get(clinicId) ?? null;
  }

  list(): ClinicSession[] {
    return [...this.sessions.values()].sort((a, b) => a.clinicId.localeCompare(b.clinicId));
  }

  patch(clinicId: string, changes: Partial<ClinicSession>): ClinicSession | null {
    const session = this.sessions.get(clinicId);
    if (!session) return null;
    Object.assign(session, changes, { updatedAt: nowIso() });
    return session;
  }

  /**
   * Records the QR Baileys emitted.
   *
   * Baileys rotates the QR roughly every 30s until the phone scans one, so
   * `qrUpdatedAt` is what lets the UI poll on a cadence and know it has fresh
   * material, and lets a stale QR be shown as expired instead of silently
   * failing to scan.
   */
  setQr(clinicId: string, qr: string): void {
    this.patch(clinicId, { qr, qrUpdatedAt: nowIso(), state: 'pairing' });
  }

  setPairingCode(clinicId: string, pairingCode: string): void {
    this.patch(clinicId, { pairingCode, pairingCodeUpdatedAt: nowIso(), state: 'pairing' });
  }

  setRequester(clinicId: string, requester: PairingCodeRequester): void {
    this.requesters.set(clinicId, requester);
  }

  clearRequester(clinicId: string): void {
    this.requesters.delete(clinicId);
  }

  /** Whether a phone number is configured for this clinic. */
  hasPhone(clinicId: string): boolean {
    return this.phoneNumbers.has(clinicId);
  }

  /**
   * Requests a pairing code for the clinic's *configured* number.
   *
   * Takes no phone argument on purpose. The number always comes from
   * `gateway-config.json`, so an authenticated caller still cannot pair a
   * number of their choosing to someone else's clinic.
   */
  async requestPairingCode(clinicId: string): Promise<string> {
    // Async so the guards below reject rather than throw synchronously: callers
    // treat this as an async operation, and a sync throw from inside an await
    // chain in the HTTP layer would escape the route's error handling.
    const requester = this.requesters.get(clinicId);
    if (!requester) {
      throw new Error(`Clinic ${clinicId} has no live socket; cannot request a pairing code.`);
    }
    const phone = this.phoneNumbers.get(clinicId);
    if (!phone) {
      throw new Error(`Clinic ${clinicId} has no phone number configured.`);
    }
    return requester(phone);
  }
}
