/**
 * HTTP surface for the gateway: liveness plus per-clinic pairing control.
 *
 * The gateway's job used to be invisible - it ran, it sent messages, and if
 * something broke the only place to look was the Render log. Pairing was the
 * sharpest version of that problem: a clinic's staff needed to scan a code on
 * the phone that owns the clinic's WhatsApp number, and the code was printed
 * in a log they had no access to. These routes let the web app drive pairing
 * and show session state directly.
 *
 * Two rules shape everything here:
 *
 * 1. Every `/api` route is admin-gated. Pairing material is a live credential:
 *    whoever holds a clinic's QR or pairing code can link their own phone to
 *    that clinic's account and read its traffic. It is gated by
 *    `GATEWAY_ADMIN_TOKEN` and refuses to serve at all when that is unset, so
 *    the default posture is closed rather than open.
 * 2. Clinic ids are looked up in the in-memory registry, never turned into file
 *    paths. A caller must name a clinic that is actually configured, which also
 *    keeps a request like `/api/clinics/../../keys/service-account/qr` from
 *    reaching the filesystem.
 *
 * Node's own `http` is used rather than Express: this is a small fixed set of
 * routes, and Express would add roughly sixty transitive packages to a service
 * that already handles clinic credentials and patient messages.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';

import type { ClinicSession, SessionRegistry } from './registry.js';

export interface HealthState {
  /** True once the config has been read and the clinics are running. */
  configured: boolean;
  clinicCount: number;
  /** Where the config came from, for diagnosing a mis-set GATEWAY_CONFIG. */
  source: string;
}

export interface ServerContext {
  health: HealthState;
  registry: SessionRegistry;
  adminToken: string | null;
  env: NodeJS.ProcessEnv;
}

const DEFAULT_PORT = 10_000;
/** Poll-friendly: Baileys rotates the QR about every 30s, so keep it short. */
const MAX_BODY_BYTES = 8 * 1024;

function json(res: ServerResponse, code: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    // content-length must be a string; a number serialises but the type is strict.
    'content-length': String(Buffer.byteLength(payload)),
  });
  res.end(payload);
}

function error(res: ServerResponse, code: number, message: string, extra?: Record<string, unknown>): void {
  json(res, code, { error: message, ...extra });
}

/**
 * Constant-time token compare.
 *
 * A plain `===` on a secret leaks its length and prefix through response
 * timing, which is enough to reconstruct a token one character at a time
 * against an endpoint that returns pairing credentials.
 */
function tokenMatches(expected: string, provided: string | null): boolean {
  if (!provided) return false;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  // timingSafeEqual throws on a length mismatch, so compare lengths first; the
  // length of a bearer token is not itself a meaningful leak.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function readBearer(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() ?? null;
}

/** Public view of a session: display state plus the live pairing material. */
function sessionPayload(session: ClinicSession): Record<string, unknown> {
  return {
    clinicId: session.clinicId,
    phoneMasked: session.phoneMasked,
    state: session.state,
    registered: session.registered,
    paired: session.state === 'connected',
    qr: session.qr,
    qrUpdatedAt: session.qrUpdatedAt,
    pairingCode: session.pairingCode,
    pairingCodeUpdatedAt: session.pairingCodeUpdatedAt,
    connectedAt: session.connectedAt,
    lastError: session.lastError,
    updatedAt: session.updatedAt,
  };
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    total += buf.length;
    // A pairing request has no reason to be large; refusing early keeps a
    // malformed or hostile client from parking memory in a long-lived process.
    if (total > MAX_BODY_BYTES) throw new Error('request body too large');
    chunks.push(buf);
  }
  if (total === 0) return null;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new Error('invalid JSON body');
  }
}

/**
 * Routes `/api/clinics/...`.
 *
 * Returns true when the request was handled, so the caller can fall through to
 * the health routes and then the 404.
 */
async function routeApi(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ServerContext,
  segments: string[],
): Promise<boolean> {
  if (segments[0] !== 'api') return false;

  // Gate before any lookup so a missing token cannot be used to probe which
  // clinics exist.
  if (!ctx.adminToken) {
    error(res, 503, 'gateway_api_disabled', {
      detail: 'Set GATEWAY_ADMIN_TOKEN to enable pairing endpoints.',
    });
    return true;
  }
  if (!tokenMatches(ctx.adminToken, readBearer(req))) {
    res.setHeader('www-authenticate', 'Bearer');
    error(res, 401, 'unauthorized');
    return true;
  }

  if (segments[1] !== 'clinics') {
    error(res, 404, 'not_found');
    return true;
  }

  // GET /api/clinics - every clinic the gateway knows about, for the picker.
  if (segments.length === 2) {
    if (req.method !== 'GET') {
      error(res, 405, 'method_not_allowed');
      return true;
    }
    const sessions = ctx.registry.list();
    json(res, 200, { clinics: sessions.map(sessionPayload) });
    return true;
  }

  const clinicId = segments[2];
  if (!clinicId) {
    error(res, 404, 'not_found');
    return true;
  }
  // Unknown id: the registry holds only configured clinics, so this also
  // rejects anything that is not a real clinic rather than touching disk.
  const session = ctx.registry.get(clinicId);
  if (!session) {
    error(res, 404, 'unknown_clinic', { clinicId });
    return true;
  }
  const action = segments[3];

  if (action === undefined) {
    if (req.method !== 'GET') {
      error(res, 405, 'method_not_allowed');
      return true;
    }
    json(res, 200, sessionPayload(session));
    return true;
  }

  // GET /api/clinics/:id/qr - the current QR string for the UI to render.
  if (action === 'qr') {
    if (req.method !== 'GET') {
      error(res, 405, 'method_not_allowed');
      return true;
    }
    json(res, 200, {
      clinicId: session.clinicId,
      state: session.state,
      registered: session.registered,
      qr: session.qr,
      qrUpdatedAt: session.qrUpdatedAt,
      pairingCode: session.pairingCode,
      updatedAt: session.updatedAt,
    });
    return true;
  }

  if (action === 'status') {
    if (req.method !== 'GET') {
      error(res, 405, 'method_not_allowed');
      return true;
    }
    json(res, 200, {
      clinicId: session.clinicId,
      phoneMasked: session.phoneMasked,
      state: session.state,
      registered: session.registered,
      paired: session.state === 'connected',
      connectedAt: session.connectedAt,
      lastError: session.lastError,
      updatedAt: session.updatedAt,
    });
    return true;
  }

  // POST /api/clinics/:id/pairing-code - mint a code for phones that cannot
  // scan a QR. Takes no phone number in the body on purpose: the gateway must
  // never be talked into pairing an arbitrary number to a clinic.
  if (action === 'pairing-code') {
    if (req.method !== 'POST') {
      error(res, 405, 'method_not_allowed');
      return true;
    }
    await readJsonBody(req).catch((cause: unknown) => {
      error(res, 400, cause instanceof Error ? cause.message : 'invalid_request');
    });
    if (res.writableEnded) return true;
    if (!ctx.registry.hasPhone(clinicId)) {
      error(res, 409, 'no_phone_configured');
      return true;
    }
    try {
      // No phone number is accepted from the request: the registry pairs the
      // clinic's configured number or nothing.
      const code = await ctx.registry.requestPairingCode(clinicId);
      json(res, 200, { clinicId, pairingCode: code });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      // No live socket means "reconnect and try again", which the UI can act
      // on; anything else is an upstream failure.
      const status = message.includes('no live socket') || message.includes('no phone number') ? 409 : 502;
      error(res, status, 'pairing_code_failed', { detail: message.slice(0, 200) });
    }
    return true;
  }

  error(res, 404, 'not_found');
  return true;
}

export function createRequestListener(ctx: ServerContext) {
  return (req: IncomingMessage, res: ServerResponse): void => {
    const path = (req.url ?? '/').split('?')[0] ?? '/';
    const segments = path.split('/').filter((s) => s !== '');

    const run = async (): Promise<void> => {
      if (await routeApi(req, res, ctx, segments)) return;

      // Health stays unauthenticated on purpose: a readiness probe that
      // needs a secret cannot be wired up in most hosts, and it exposes no
      // clinic data. `configured` is reported, never enforced, so a correctly
      // idle gateway reads as up.
      if (req.method === 'GET' && (path === '/health' || path === '/healthz')) {
        json(res, 200, { status: 'ok', configured: ctx.health.configured, clinics: ctx.health.clinicCount });
        return;
      }
      if (req.method === 'GET' && path === '/') {
        json(res, 200, {
          status: 'ok',
          service: 'mediflow-baileys-gateway',
          configured: ctx.health.configured,
          clinics: ctx.health.clinicCount,
        });
        return;
      }
      error(res, 404, 'not_found');
    };

    void run().catch((cause: unknown) => {
      const message = cause instanceof Error ? cause.message : String(cause);
      process.stderr.write(`request error ${req.method ?? '?'} ${path}: ${message}\n`);
      if (!res.headersSent) {
        error(res, 500, 'internal_error');
      } else {
        res.end();
      }
    });
  };
}

/**
 * Starts the HTTP server.
 *
 * `0.0.0.0` is deliberate: a server bound to loopback is unreachable from
 * outside the container, which is indistinguishable from not listening at all
 * and produces exactly the port-scan timeout this exists to solve.
 */
export function startServer(ctx: ServerContext): Server {
  const raw = ctx.env.PORT?.trim();
  const port = raw ? Number(raw) : DEFAULT_PORT;
  // 0 is allowed: it asks the OS for an ephemeral port, which is what the
  // tests use to avoid fighting over a fixed one.
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`PORT is not a valid port number: ${JSON.stringify(raw)}`);
  }

  const server = createServer(createRequestListener(ctx));

  // A bind failure is a real deployment error (usually a taken port), and
  // swallowing it would put us straight back to a silent port-scan timeout.
  server.on('error', (err: unknown) => {
    process.stderr.write(`gateway server error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });

  server.listen(port, '0.0.0.0', () => {
    process.stdout.write(
      `Gateway HTTP listening on 0.0.0.0:${port} (health: /health, pairing: /api/clinics/:id/qr${
        ctx.adminToken ? '' : ' [disabled: GATEWAY_ADMIN_TOKEN unset]'
      })\n`,
    );
  });

  return server;
}
