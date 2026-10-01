/**
 * Registry and HTTP route tests.
 *
 * The pairing routes are the only thing standing between an unauthenticated
 * caller and a clinic's live WhatsApp session, so the auth gate, the clinic-id
 * lookup, and the "never pair a number the caller chose" rule are all pinned
 * here rather than left to a manual smoke test.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import { SessionRegistry, maskPhone } from '../src/registry.js';
import { startServer, type ServerContext } from '../src/http.js';

const TOKEN = 'test-admin-token-9f2b';

function makeCtx(overrides: Partial<ServerContext> = {}): ServerContext {
  const registry = overrides.registry ?? new SessionRegistry();
  return {
    health: { configured: true, clinicCount: 1, source: 'test' },
    registry,
    adminToken: TOKEN,
    env: {},
    ...overrides,
  };
}

async function withServer(ctx: ServerContext, fn: (base: string) => Promise<void>): Promise<void> {
  const server = startServer(ctx);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function get(url: string, token?: string): Promise<Response> {
  return fetch(url, { headers: token ? { authorization: `Bearer ${token}` } : {} });
}

describe('maskPhone', () => {
  it('keeps only the country prefix and last three digits', () => {
    const masked = maskPhone('+966501234567');
    expect(masked.startsWith('+966')).toBe(true);
    expect(masked.endsWith('567')).toBe(true);
    // The subscriber digits must not survive masking.
    expect(masked).not.toContain('501234');
  });

  it('short numbers are not padded into something misleading', () => {
    expect(maskPhone('1234')).toBe('+1234');
  });
});

describe('SessionRegistry', () => {
  it('declares a clinic as pending before any socket exists', () => {
    const registry = new SessionRegistry();
    const session = registry.declare('clinic-a', '966501234567');
    expect(session.state).toBe('pending');
    expect(session.registered).toBe(false);
    expect(session.phoneMasked).toBe(maskPhone('966501234567'));
  });

  it('tracks qr rotation and flips to pairing', () => {
    const registry = new SessionRegistry();
    registry.declare('clinic-a', '966501234567');
    registry.setQr('clinic-a', 'QR-ONE');
    expect(registry.get('clinic-a')?.qr).toBe('QR-ONE');
    expect(registry.get('clinic-a')?.state).toBe('pairing');
    registry.setQr('clinic-a', 'QR-TWO');
    expect(registry.get('clinic-a')?.qr).toBe('QR-TWO');
  });

  it('ignores patches for clinics that were never declared', () => {
    const registry = new SessionRegistry();
    expect(registry.patch('ghost', { state: 'connected' })).toBeNull();
  });

  it('refuses a pairing code when no socket is live', async () => {
    const registry = new SessionRegistry();
    registry.declare('clinic-a', '966501234567');
    await expect(registry.requestPairingCode('clinic-a')).rejects.toThrow(/no live socket/);
  });

  it('pairs the configured number, never one supplied by the caller', async () => {
    const registry = new SessionRegistry();
    registry.declare('clinic-a', '966501234567');
    const seen: string[] = [];
    registry.setRequester('clinic-a', async (phone) => {
      seen.push(phone);
      return '12345678';
    });
    const code = await registry.requestPairingCode('clinic-a');
    expect(code).toBe('12345678');
    expect(seen).toEqual(['966501234567']);
  });

  it('refuses to pair a clinic with no configured number', async () => {
    const registry = new SessionRegistry();
    registry.declare('clinic-a', null);
    registry.setRequester('clinic-a', async () => 'nope');
    await expect(registry.requestPairingCode('clinic-a')).rejects.toThrow(/no phone number/);
  });
});

describe('gateway http routes', () => {
  let registry: SessionRegistry;

  beforeEach(() => {
    registry = new SessionRegistry();
    registry.declare('clinic-a', '966501234567');
  });

  afterEach(() => {
    registry = new SessionRegistry();
  });

  it('serves /health without a token so a host probe can work', async () => {
    await withServer(makeCtx({ registry }), async (base) => {
      const res = await get(`${base}/health`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body['status']).toBe('ok');
      expect(body['configured']).toBe(true);
    });
  });

  it('rejects /api without a token', async () => {
    await withServer(makeCtx({ registry }), async (base) => {
      const res = await get(`${base}/api/clinics`);
      expect(res.status).toBe(401);
      expect(res.headers.get('www-authenticate')).toBe('Bearer');
    });
  });

  it('rejects a wrong token', async () => {
    await withServer(makeCtx({ registry }), async (base) => {
      expect((await get(`${base}/api/clinics`, 'wrong-token')).status).toBe(401);
    });
  });

  it('closes the api entirely when no admin token is configured', async () => {
    await withServer(makeCtx({ registry, adminToken: null }), async (base) => {
      const res = await get(`${base}/api/clinics`, TOKEN);
      expect(res.status).toBe(503);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body['error']).toBe('gateway_api_disabled');
    });
  });

  it('lists clinics for the picker', async () => {
    registry.declare('clinic-b', '966509999999');
    await withServer(makeCtx({ registry }), async (base) => {
      const res = await get(`${base}/api/clinics`, TOKEN);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { clinics: { clinicId: string }[] };
      expect(body.clinics.map((c) => c.clinicId)).toEqual(['clinic-a', 'clinic-b']);
    });
  });

  it('returns the current qr for a clinic', async () => {
    registry.setQr('clinic-a', 'QR-DATA');
    await withServer(makeCtx({ registry }), async (base) => {
      const res = await get(`${base}/api/clinics/clinic-a/qr`, TOKEN);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body['qr']).toBe('QR-DATA');
      expect(body['qrUpdatedAt']).toBeTruthy();
    });
  });

  it('returns a null qr rather than 404 when there is nothing to scan', async () => {
    await withServer(makeCtx({ registry }), async (base) => {
      const res = await get(`${base}/api/clinics/clinic-a/qr`, TOKEN);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body['qr']).toBeNull();
    });
  });

  it('reports session status', async () => {
    registry.patch('clinic-a', { state: 'connected', registered: true });
    await withServer(makeCtx({ registry }), async (base) => {
      const res = await get(`${base}/api/clinics/clinic-a/status`, TOKEN);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body['state']).toBe('connected');
      expect(body['paired']).toBe(true);
    });
  });

  it('404s an unknown clinic instead of guessing at storage', async () => {
    await withServer(makeCtx({ registry }), async (base) => {
      const res = await get(`${base}/api/clinics/does-not-exist/qr`, TOKEN);
      expect(res.status).toBe(404);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body['error']).toBe('unknown_clinic');
    });
  });

  it('does not let a traversal-shaped clinic id reach the filesystem', async () => {
    await withServer(makeCtx({ registry }), async (base) => {
      const res = await get(`${base}/api/clinics/${encodeURIComponent('../../keys/sa')}/qr`, TOKEN);
      expect(res.status).toBe(404);
    });
  });

  it('mints a pairing code from the configured number', async () => {
    const seen: string[] = [];
    registry.setRequester('clinic-a', async (phone) => {
      seen.push(phone);
      return '99887766';
    });
    await withServer(makeCtx({ registry }), async (base) => {
      const res = await fetch(`${base}/api/clinics/clinic-a/pairing-code`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ phoneNumber: '15551230000' }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body['pairingCode']).toBe('99887766');
      // The phone number in the body is ignored: the configured one is used.
      expect(seen).toEqual(['966501234567']);
    });
  });

  it('409s a pairing-code request when the socket is down', async () => {
    await withServer(makeCtx({ registry }), async (base) => {
      const res = await fetch(`${base}/api/clinics/clinic-a/pairing-code`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(res.status).toBe(409);
    });
  });

  it('rejects a malformed json body', async () => {
    registry.setRequester('clinic-a', async () => '1');
    await withServer(makeCtx({ registry }), async (base) => {
      const res = await fetch(`${base}/api/clinics/clinic-a/pairing-code`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: '{not json',
      });
      expect(res.status).toBe(400);
    });
  });

  it('405s the wrong method on a qr route', async () => {
    await withServer(makeCtx({ registry }), async (base) => {
      const res = await fetch(`${base}/api/clinics/clinic-a/qr`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(res.status).toBe(405);
    });
  });

  it('404s an unknown api path', async () => {
    await withServer(makeCtx({ registry }), async (base) => {
      expect((await get(`${base}/api/unknown`, TOKEN)).status).toBe(404);
    });
  });

  it('404s a non-api path without a token', async () => {
    await withServer(makeCtx({ registry }), async (base) => {
      expect((await get(`${base}/nope`)).status).toBe(404);
    });
  });

  it('honours PORT from the env', async () => {
    const port = 20_000 + Math.floor(Math.random() * 5_000);
    const server = startServer(makeCtx({ registry, env: { PORT: String(port) } }));
    await new Promise<void>((resolve) => server.once('listening', resolve));
    try {
      const res = await get(`http://127.0.0.1:${port}/health`);
      expect(res.status).toBe(200);
    } finally {
      server.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('rejects a nonsense PORT rather than silently defaulting', () => {
    expect(() => startServer(makeCtx({ registry, env: { PORT: 'not-a-port' } }))).toThrow(/PORT/);
  });

  it('closes cleanly so tests do not leak the handle', async () => {
    const server: Server = startServer(makeCtx({ registry, env: { PORT: '0' } }));
    await new Promise<void>((resolve) => server.once('listening', resolve));
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(server.listening).toBe(false);
  });
});
