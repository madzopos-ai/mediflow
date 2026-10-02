/**
 * API poll tests.
 *
 * The poll loop is the only path by which API-queued messages reach WhatsApp
 * when the gateway sits behind NAT, so its contract is pinned from both
 * sides: it sends exactly what the API hands out, acks exactly what it
 * attempted, and never spends attempts on rows it skipped.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { pollDelayMs, startApiPoll } from '../src/apiPoll.js';

interface Seen {
  pendingHits: number;
  acks: { id: string; ok: boolean }[];
}

let server: Server;
let base: string;
let seen: Seen;
let mode: 'ok' | 'empty' | 'error' | 'malformed';

function startFakeApi(): Promise<void> {
  return new Promise((resolve) => {
    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://x');
      let body = '';
      req.on('data', (c) => {
        body += c;
      });
      req.on('end', () => {
        if (url.pathname === '/gateway/outbox/pending') {
          seen.pendingHits += 1;
          if (req.headers['authorization'] !== 'Bearer test-token') {
            res.writeHead(403).end('{}');
            return;
          }
          if (mode === 'error') {
            res.writeHead(500).end('{}');
            return;
          }
          if (mode === 'malformed') {
            res.writeHead(200, { 'content-type': 'application/json' }).end('{"messages":"nope"}');
            return;
          }
          const messages =
            mode === 'empty'
              ? []
              : [
                  { id: 'row-1', to: '+96170123456', body: 'Hello' },
                  { id: 'row-2', to: '+96170999888', body: 'World' },
                ];
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, messages }));
          return;
        }
        if (url.pathname === '/gateway/outbox/ack') {
          const parsed = JSON.parse(body) as { id: string; ok: boolean };
          seen.acks.push({ id: parsed.id, ok: parsed.ok });
          res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
          return;
        }
        res.writeHead(404).end('{}');
      });
    });
    server.listen(0, '127.0.0.1', () => {
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      resolve();
    });
  });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition');
    await sleep(25);
  }
}

beforeEach(async () => {
  seen = { pendingHits: 0, acks: [] };
  mode = 'ok';
  await startFakeApi();
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function poll(overrides: Partial<Parameters<typeof startApiPoll>[0]> = {}): {
  stop: () => void;
  sent: { to: string; body: string }[];
} {
  const sent: { to: string; body: string }[] = [];
  const cfg = {
    apiUrl: base,
    adminToken: 'test-token',
    clinicId: 'clc_1',
    intervalMs: 50,
    isConnected: () => true,
    send: async (to: string, body: string) => {
      sent.push({ to, body });
      return 'wa-mid-1';
    },
    log: () => undefined,
    logError: () => undefined,
    ...overrides,
  };
  const stop = startApiPoll(cfg);
  return { stop, sent };
}

describe('pollDelayMs', () => {
  it('returns the base interval with no failures', () => {
    expect(pollDelayMs(15000, 0)).toBe(15000);
  });

  it('backs off exponentially and caps at five minutes', () => {
    expect(pollDelayMs(15000, 1)).toBe(30000);
    expect(pollDelayMs(15000, 2)).toBe(60000);
    expect(pollDelayMs(15000, 20)).toBe(300000);
  });
});

describe('startApiPoll', () => {
  it('sends pending rows and acks each with the provider id', async () => {
    const p = poll();
    try {
      await waitFor(() => seen.acks.length === 2);
      expect(p.sent).toHaveLength(2);
      expect(p.sent[0]).toEqual({ to: '+96170123456', body: 'Hello' });
      expect(seen.acks).toEqual([
        { id: 'row-1', ok: true },
        { id: 'row-2', ok: true },
      ]);
    } finally {
      p.stop();
    }
  });

  it('sends nothing and acks nothing while disconnected', async () => {
    let connected = true;
    const sent: { to: string; body: string }[] = [];
    const stop = startApiPoll({
      apiUrl: base,
      adminToken: 'test-token',
      clinicId: 'clc_1',
      intervalMs: 50,
      isConnected: () => connected,
      send: async (to: string, body: string) => {
        sent.push({ to, body });
        return null;
      },
      log: () => undefined,
      logError: () => undefined,
    });
    try {
      connected = false;
      await sleep(250);
      // The poll still runs (rows stay claimed server-side and requeue on
      // expiry), but no send is attempted and no ack is emitted.
      expect(sent).toHaveLength(0);
      expect(seen.acks).toHaveLength(0);
    } finally {
      stop();
    }
  });

  it('acks failures instead of dropping them', async () => {
    const p = poll({
      send: async () => {
        throw new Error('no session');
      },
    });
    try {
      await waitFor(() => seen.acks.length === 2);
      expect(seen.acks.every((a) => a.ok === false)).toBe(true);
    } finally {
      p.stop();
    }
  });

  it('ignores malformed payloads without crashing', async () => {
    mode = 'malformed';
    const p = poll();
    try {
      await sleep(250);
      expect(seen.acks).toHaveLength(0);
    } finally {
      p.stop();
    }
  });

  it('does nothing when the api url is unset', async () => {
    const logged: string[] = [];
    const stop = startApiPoll({
      apiUrl: '',
      adminToken: 'test-token',
      clinicId: 'clc_1',
      intervalMs: 50,
      isConnected: () => true,
      send: async () => null,
      log: (m) => logged.push(m),
      logError: () => undefined,
    });
    stop();
    expect(logged.join(' ')).toContain('MEDIFLOW_API_URL');
    expect(seen.pendingHits).toBe(0);
  });
});
