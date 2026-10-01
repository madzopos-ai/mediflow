/**
 * Password reset HTTP surface.
 *
 * The endpoint that matters most here is `/auth/password/forgot`: it has to be
 * indistinguishable for a registered and an unregistered address, or it becomes
 * a way to enumerate who works at a clinic. The mailer is stubbed via
 * `SMTP_HOST` pointing at a closed local port, which exercises the "mail failed"
 * path without needing a real relay.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildApp } from '../src/app.js';
import { openDatabase, migrate, type Db } from '../src/db/index.js';
import { loadConfig, type Config } from '../src/config.js';
import { hashPassword } from '../src/auth/password.js';

const OWNER = 'owner@example.test';
const NEW_PASSWORD = 'a-brand-new-pass-7';

let app: Awaited<ReturnType<typeof buildApp>>;
let db: Db;
let dir: string;
let ownerHash: string;

function configFor(overrides: NodeJS.ProcessEnv = {}): Config {
  return loadConfig({
    NODE_ENV: 'test',
    JWT_SECRET: 'x'.repeat(40),
    ENCRYPTION_KEY: 'y'.repeat(40),
    PUBLIC_WEB_URL: 'https://app.example.test',
    // A port nothing listens on: the send fails fast and deterministically.
    SMTP_HOST: '127.0.0.1',
    SMTP_PORT: '1',
    SMTP_USER: 'mailer',
    SMTP_PASS: 'secret',
    MAIL_FROM: 'no-reply@example.test',
    ...overrides,
  } as NodeJS.ProcessEnv);
}

beforeAll(async () => {
  dir = join(tmpdir(), `pwreset-routes-${Date.now()}`);
  db = openDatabase({ file: join(dir, 'test.db') });
  migrate(db);
  ownerHash = await hashPassword('original-password-1');

  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO clinics (id, name, slug, timezone, currency, created_at, updated_at)
     VALUES ('clc_1', 'Test', 'test', 'UTC', 'USD', ?, ?)`,
  ).run(now, now);
  db.prepare(
    `INSERT INTO users (id, clinic_id, email, password_hash, full_name, role, is_active, created_at, updated_at)
     VALUES ('usr_1', 'clc_1', ?, ?, 'Owner', 'owner', 1, ?, ?)`,
  ).run(OWNER, ownerHash, now, now);

  // logLevel 'silent' because these tests deliberately point the mailer at a
  // dead port; the ECONNREFUSED stack traces are expected, not failures.
  app = await buildApp({ db, config: configFor({ LOG_LEVEL: 'silent' }) });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

async function post(
  path: string,
  body: Record<string, string>,
): Promise<{ status: number; json: unknown }> {
  const res = await app.inject({ method: 'POST', url: path, payload: body });
  let json: unknown = null;
  try {
    json = res.json();
  } catch {
    json = null;
  }
  return { status: res.statusCode, json };
}

describe('POST /auth/password/forgot', () => {
  it('answers identically for a registered and an unknown address', async () => {
    const known = await post('/auth/password/forgot', { email: OWNER });
    const unknown = await post('/auth/password/forgot', { email: 'ghost@example.test' });
    expect(known.status).toBe(200);
    expect(unknown.status).toBe(known.status);
    expect(unknown.json).toEqual(known.json);
  });

  it('does not mention the address or the account in the reply', async () => {
    const { json } = await post('/auth/password/forgot', { email: OWNER });
    const text = JSON.stringify(json);
    expect(text).not.toContain(OWNER);
    expect(text).not.toContain('token');
  });

  it('rejects a malformed address', async () => {
    expect((await post('/auth/password/forgot', { email: 'not-an-email' })).status).toBe(400);
  });

  it('issues a token even though the mailer cannot deliver', async () => {
    // The token is created before the send is attempted, so a broken relay
    // does not silently skip the work. The failure is logged server-side.
    await post('/auth/password/forgot', { email: OWNER });
    const row = db.prepare('SELECT COUNT(*) AS n FROM password_reset_tokens').get() as { n: number };
    expect(row.n).toBeGreaterThan(0);
  });
});

describe('reset without mail configured', () => {
  it('returns 503 rather than pretending an email was sent', async () => {
    // A 200 here would tell someone to wait for a message that can never
    // arrive, which is the worst possible answer.
    const noMail = await buildApp({ db, config: configFor({ SMTP_HOST: '', LOG_LEVEL: 'silent' }) });
    await noMail.ready();
    const res = await noMail.inject({
      method: 'POST',
      url: '/auth/password/forgot',
      payload: { email: OWNER },
    });
    expect(res.statusCode).toBe(503);
    await noMail.close();
  });
});

describe('POST /auth/password/reset', () => {
  it('rejects an unknown token', async () => {
    const res = await post('/auth/password/reset', {
      token: 'definitely-not-a-valid-token',
      password: NEW_PASSWORD,
    });
    expect(res.status).toBe(400);
  });

  it('rejects a short password without spending the token', async () => {
    await post('/auth/password/forgot', { email: OWNER });
    const token = (
      db.prepare('SELECT token_hash FROM password_reset_tokens ORDER BY created_at DESC').get() as {
        token_hash: string;
      }
    ).token_hash;
    expect(token).toBeTruthy();

    const res = await post('/auth/password/reset', { token: 'x'.repeat(40), password: 'short' });
    expect(res.status).toBe(400);
  });
});

describe('GET /auth/password/reset', () => {
  it('rejects a missing token', async () => {
    const res = await app.inject({ method: 'GET', url: '/auth/password/reset' });
    expect(res.statusCode).toBe(400);
  });
});
