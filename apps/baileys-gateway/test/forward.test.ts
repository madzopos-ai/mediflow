/**
 * Inbound-forward isolation tests.
 *
 * The hard rule of a multi-doctor setup: a message arriving on clinic A's
 * session must reach clinic A and no one else. The forward carries the
 * clinic id from the session closure (never from the message), and the API
 * scopes everything by it - this test pins the gateway half by capturing
 * what actually leaves over HTTP.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { forwardToApi } from '../src/clinic.js';

interface Seen {
  posts: { clinicId: string; from: string; text: string }[];
}

let server: Server;
let base: string;
let seen: Seen;
let fail: boolean;

function startFakeApi(): Promise<void> {
  return new Promise((resolve) => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => {
        body += c;
      });
      req.on('end', () => {
        if (req.url === '/gateway/inbound' && req.method === 'POST') {
          if (fail) {
            res.writeHead(500).end('{}');
            return;
          }
          const parsed = JSON.parse(body) as { clinicId: string; from: string; text: string };
          seen.posts.push({ clinicId: parsed.clinicId, from: parsed.from, text: parsed.text });
          res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true,"action":"ignored"}');
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

const OLD_ENV = { ...process.env };

beforeEach(async () => {
  seen = { posts: [] };
  fail = false;
  await startFakeApi();
  process.env['MEDIFLOW_API_URL'] = base;
  process.env['GATEWAY_ADMIN_TOKEN'] = 'test-token';
});

afterEach(async () => {
  process.env = { ...OLD_ENV };
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('forwardToApi', () => {
  it("carries the session's clinic id, so clinic A's message can never land in clinic B", async () => {
    await forwardToApi('clc_A', '+96170111111', 'بدي احجز بكرة');
    await forwardToApi('clc_B', '+96170222222', 'بدي احجز بكرة');
    expect(seen.posts).toEqual([
      { clinicId: 'clc_A', from: '+96170111111', text: 'بدي احجز بكرة' },
      { clinicId: 'clc_B', from: '+96170222222', text: 'بدي احجز بكرة' },
    ]);
  });

  it('stays silent when no API is configured (pairing-only setups)', async () => {
    delete process.env['MEDIFLOW_API_URL'];
    await forwardToApi('clc_A', '+96170111111', 'مرحبا');
    expect(seen.posts).toHaveLength(0);
  });

  it('throws (for the caller to log) when the API refuses, never crashing the loop', async () => {
    fail = true;
    await expect(forwardToApi('clc_A', '+96170111111', 'مرحبا')).rejects.toThrow('API 500');
    expect(seen.posts).toHaveLength(0);
  });
});
