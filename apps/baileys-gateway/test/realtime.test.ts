/**
 * Realtime session stream + single-instance lock.
 *
 * The QR must reach the Link-a-Device panel the moment Baileys rotates it,
 * and two gateway copies must never fight over one session directory (that
 * fight is what used to end in `Connection Closed` + a forced logout).
 */

import { describe, it, expect } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SessionRegistry } from '../src/registry.js';
import { startServer, type ServerContext } from '../src/http.js';
import { acquireSingleInstanceLock } from '../src/lock.js';

const TOKEN = 'test-admin-token-realtime';

function makeCtx(registry: SessionRegistry): ServerContext {
  return {
    health: { configured: true, clinicCount: 1, source: 'test' },
    registry,
    adminToken: TOKEN,
    env: {},
  };
}

async function withServer(ctx: ServerContext, fn: (base: string) => Promise<void>): Promise<void> {
  const server: Server = startServer({ ...ctx, env: { ...ctx.env, PORT: '0' } });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function readFirstSessionEvent(url: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${TOKEN}`, accept: 'text/event-stream' },
      signal: controller.signal,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const end = buffer.indexOf('\n\n');
      if (end !== -1 && buffer.includes('event: session')) {
        const first = buffer.slice(0, end);
        try {
          await reader.cancel();
        } catch {
          // Already closed by the server on settled states.
        }
        return first;
      }
      if (buffer.length > 64 * 1024) throw new Error('no session event in first 64k');
    }
    throw new Error('stream ended without a session event');
  } finally {
    clearTimeout(timeout);
  }
}

describe('GET /api/clinics/:id/events (SSE)', () => {
  it('is admin-gated like every pairing route', async () => {
    const registry = new SessionRegistry();
    registry.declare('clinic-a', '966501234567');
    await withServer(makeCtx(registry), async (base) => {
      const noAuth = await fetch(`${base}/api/clinics/clinic-a/events`);
      expect(noAuth.status).toBe(401);
    });
  });

  it('pushes the live session immediately, including the QR', async () => {
    const registry = new SessionRegistry();
    registry.declare('clinic-a', '966501234567');
    registry.setQr('clinic-a', 'QR-LIVE-1');
    await withServer(makeCtx(registry), async (base) => {
      const first = await readFirstSessionEvent(`${base}/api/clinics/clinic-a/events`);
      expect(first).toContain('QR-LIVE-1');
      expect(first).toContain('pairing');
    });
  });

  it('404s for a clinic that was never declared', async () => {
    const registry = new SessionRegistry();
    await withServer(makeCtx(registry), async (base) => {
      const res = await fetch(`${base}/api/clinics/nope/events`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(res.status).toBe(404);
    });
  });
});

describe('acquireSingleInstanceLock', () => {
  it('lets the same process re-acquire and cleans up on release', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gw-lock-'));
    try {
      const release = acquireSingleInstanceLock(dir);
      expect(() => acquireSingleInstanceLock(dir)).not.toThrow();
      release();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ignores a stale lock from a dead PID', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gw-lock-stale-'));
    try {
      writeFileSync(join(dir, '.gateway.lock'), JSON.stringify({ pid: 2_147_483_647 }), 'utf8');
      expect(() => acquireSingleInstanceLock(dir)()).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
