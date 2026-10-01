/**
 * Gateway pairing proxy.
 *
 * The browser never talks to the Baileys gateway directly. `GATEWAY_ADMIN_TOKEN`
 * grants access to *every* clinic's pairing material, so a bundle that carried
 * it would hand every signed-in user the ability to read another clinic's QR
 * and link their own phone to it. Instead this service holds the token and
 * forwards only the caller's own `clinicId`, which the route takes from the
 * signed session.
 *
 * The clinic id is an argument, never derived from anything the client sent, so
 * a caller cannot ask for a different clinic by editing a request.
 */

import type { Config } from '../config.js';

/** Mirrors the gateway's session payload, minus the fields this app ignores. */
export interface GatewaySession {
  clinicId: string;
  state: string;
  registered: boolean;
  paired: boolean;
  qr: string | null;
  qrUpdatedAt: string | null;
  pairingCode: string | null;
  connectedAt: string | null;
  lastError: string | null;
  updatedAt: string | null;
}

export type GatewayResult<T> =
  | { ok: true; data: T }
  /** The gateway is not configured, or is unreachable. Not the caller's fault. */
  | { ok: false; kind: 'unavailable'; message: string }
  /** The gateway answered, but refused us. An operator problem. */
  | { ok: false; kind: 'rejected'; message: string };

/**
 * Short by design: this sits in a request handler, and a clinic staring at a
 * "connecting to the gateway" spinner should get an answer fast enough to retry.
 */
const TIMEOUT_MS = 8_000;

function sessionFrom(raw: unknown, fallbackId: string): GatewaySession {
  const d = (raw ?? {}) as Record<string, unknown>;
  const str = (key: string): string | null => (typeof d[key] === 'string' ? (d[key] as string) : null);
  return {
    clinicId: str('clinicId') ?? fallbackId,
    state: str('state') ?? 'unknown',
    registered: d['registered'] === true,
    paired: d['paired'] === true,
    qr: str('qr'),
    qrUpdatedAt: str('qrUpdatedAt'),
    pairingCode: str('pairingCode'),
    connectedAt: str('connectedAt'),
    lastError: str('lastError'),
    updatedAt: str('updatedAt'),
  };
}

async function callGateway<T>(
  config: Config,
  path: string,
  init: RequestInit = {},
): Promise<GatewayResult<T>> {
  if (!config.gatewayUrl || !config.gatewayAdminToken) {
    return {
      ok: false,
      kind: 'unavailable',
      message: 'Device linking is not configured on this server.',
    };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${config.gatewayUrl}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${config.gatewayAdminToken}`,
        accept: 'application/json',
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        ...(init.headers ?? {}),
      },
    });
    if (res.status === 401 || res.status === 503) {
      return {
        ok: false,
        kind: 'rejected',
        message:
          res.status === 401
            ? 'The gateway rejected this server’s admin token. Check GATEWAY_ADMIN_TOKEN.'
            : 'The gateway has pairing disabled. Set GATEWAY_ADMIN_TOKEN on the gateway.',
      };
    }
    if (!res.ok) {
      return { ok: false, kind: 'rejected', message: `Gateway responded ${res.status}.` };
    }
    return { ok: true, data: (await res.json()) as T };
  } catch (error) {
    // An abort is a timeout and a fetch failure is a dead gateway; both are the
    // same thing to the person waiting: the pairing service is not reachable.
    const aborted = error instanceof Error && error.name === 'AbortError';
    return {
      ok: false,
      kind: 'unavailable',
      message: aborted
        ? 'The gateway did not respond in time.'
        : 'Could not reach the gateway.',
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Current pairing state and QR for one clinic. */
export async function gatewaySession(
  config: Config,
  clinicId: string,
): Promise<GatewayResult<GatewaySession>> {
  const result = await callGateway<{ qr?: unknown }>(
    config,
    `/api/clinics/${encodeURIComponent(clinicId)}`,
  );
  if (!result.ok) return result;
  return { ok: true, data: sessionFrom(result.data, clinicId) };
}

/** Requests an 8-digit code for phones that cannot scan a QR. */
export async function gatewayPairingCode(
  config: Config,
  clinicId: string,
): Promise<GatewayResult<{ pairingCode: string }>> {
  const result = await callGateway<{ pairingCode?: unknown }>(
    config,
    `/api/clinics/${encodeURIComponent(clinicId)}/pairing-code`,
    { method: 'POST', body: '{}' },
  );
  if (!result.ok) return result;
  const code = (result.data as { pairingCode?: unknown }).pairingCode;
  if (typeof code !== 'string' || code.length === 0) {
    return { ok: false, kind: 'rejected', message: 'The gateway returned no pairing code.' };
  }
  return { ok: true, data: { pairingCode: code } };
}
