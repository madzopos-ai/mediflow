/**
 * POST /system/bootstrap tests.
 *
 * The route is a loaded gun pointed at user creation, so every guard gets a
 * test: no token configured means the endpoint does not exist (404, not 403,
 * so scanners learn nothing), a wrong token is refused without creating
 * anything, and success works exactly once.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildApp } from '../src/app.js';
import { openDatabase, migrate, type Db } from '../src/db/index.js';
import { loadConfig, type Config } from '../src/config.js';

const TOKEN = 'test-bootstrap-token-that-is-long-enough';

let app: Awaited<ReturnType<typeof buildApp>>;
let db: Db;
let dir: string;

function configFor(overrides: Record<string, string> = {}): Config {
  return loadConfig({
    NODE_ENV: 'test',
    JWT_SECRET: 'x'.repeat(40),
    ENCRYPTION_KEY: 'y'.repeat(40),
    LOG_LEVEL: 'silent',
    BOOTSTRAP_TOKEN: TOKEN,
    ...overrides,
  } as unknown as NodeJS.ProcessEnv);
}

beforeAll(async () => {
  dir = join(tmpdir(), `bootstrap-routes-${Date.now()}`);
  db = openDatabase({ file: join(dir, 'test.db') });
  migrate(db);
  app = await buildApp({ db, config: configFor() });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

async function post(body: Record<string, string>): Promise<{ status: number; json: unknown }> {
  const res = await app.inject({ method: 'POST', url: '/system/bootstrap', payload: body });
  let json: unknown = null;
  try {
    json = res.json();
  } catch {
    json = null;
  }
  return { status: res.statusCode, json };
}

const GOOD = { token: TOKEN, email: 'owner@example.test', password: 'a-strong-pass-1' };

describe('POST /system/bootstrap', () => {
  it('refuses a wrong token without creating anything', async () => {
    const res = await post({ ...GOOD, token: 'wrong-token' });
    expect(res.status).toBe(403);
    expect((db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n).toBe(0);
  });

  it('creates the first owner with the right token', async () => {
    const res = await post(GOOD);
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ ok: true, ownerEmail: 'owner@example.test' });
  });

  it('refuses a second bootstrap even with the right token', async () => {
    const res = await post({ ...GOOD, email: 'someone-else@example.test' });
    expect(res.status).toBe(409);
  });

  it('rejects a weak password', async () => {
    // Fresh database so the password rule is what is actually tested.
    const fresh = join(dir, 'fresh.db');
    const db2 = openDatabase({ file: fresh });
    migrate(db2);
    const app2 = await buildApp({ db: db2, config: configFor() });
    await app2.ready();
    const res = await app2.inject({
      method: 'POST',
      url: '/system/bootstrap',
      payload: { ...GOOD, password: 'short' },
    });
    expect(res.statusCode).toBe(400);
    await app2.close();
    db2.close();
  });

  it('behaves as 404 when no token is configured', async () => {
    const noToken = await buildApp({ db, config: configFor({ BOOTSTRAP_TOKEN: '' }) });
    await noToken.ready();
    const res = await noToken.inject({ method: 'POST', url: '/system/bootstrap', payload: GOOD });
    expect(res.statusCode).toBe(404);
    await noToken.close();
  });
});
