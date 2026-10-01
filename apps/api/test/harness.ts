/**
 * Test harness.
 *
 * Every suite gets a real Fastify instance on a real SQLite file database, not a
 * mock: the failure modes worth catching here (SQL constraints, transaction
 * races, timezone conversion, tenant scoping) only exist against a real engine.
 * `:memory:` would work, but a temp file matches production's durability and
 * lets a failing test be inspected after the run.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';

import { buildApp } from '../src/app.js';
import { loadConfig, type Config } from '../src/config.js';
import { openDatabase, type Db } from '../src/db/index.js';
import { seed, type SeedResult } from '../src/db/seed.js';

export interface Harness {
  app: FastifyInstance;
  db: Db;
  config: Config;
  dir: string;
  clinic: SeedResult;
  /** Logs in and returns the bearer token plus the auth header. */
  login(email?: string, password?: string): Promise<{ token: string; auth: string }>;
  close(): Promise<void>;
}

export const OWNER_EMAIL = 'owner@mediflow.test';
export const OWNER_PASSWORD = 'ChangeMe!2026';

export function testConfig(overrides: Partial<Config> = {}): Config {
  const base = loadConfig({
    NODE_ENV: 'test',
    JWT_SECRET: 'test-secret-that-is-definitely-long-enough-32',
    ENCRYPTION_KEY: 'test-encryption-key-32-bytes-long!!!!',
    DATABASE_FILE: ':memory:',
  });
  return {
    ...base,
    whatsappProvider: 'simulator',
    reminderWorkerEnabled: false,
    logLevel: 'silent',
    ...overrides,
  };
}

export async function createHarness(overrides: Partial<Config> = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'mediflow-test-'));
  const config = testConfig({ databaseFile: join(dir, 'test.db'), ...overrides });
  const db = openDatabase({ file: config.databaseFile });
  const app = await buildApp({ db, config });
  const clinic = await seed(db, { ownerEmail: OWNER_EMAIL, ownerPassword: OWNER_PASSWORD });

  return {
    app,
    db,
    config,
    dir,
    clinic,
    async login(email = OWNER_EMAIL, password = OWNER_PASSWORD) {
      const response = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email, password },
      });
      if (response.statusCode !== 200) {
        throw new Error(`login failed: ${response.statusCode} ${response.body}`);
      }
      const token = response.json().token as string;
      return { token, auth: `Bearer ${token}` };
    },
    async close() {
      await app.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** POST/PATCH/GET helper that always sends the auth header. */
export function asClient(app: FastifyInstance, auth: string) {
  return {
    get: (url: string) => app.inject({ method: 'GET', url, headers: { authorization: auth } }),
    post: (url: string, payload?: unknown) =>
      app.inject({
        method: 'POST',
        url,
        headers: { authorization: auth },
        ...(payload === undefined ? {} : { payload: payload as object }),
      }),
    patch: (url: string, payload?: unknown) =>
      app.inject({
        method: 'PATCH',
        url,
        headers: { authorization: auth },
        ...(payload === undefined ? {} : { payload: payload as object }),
      }),
    del: (url: string) => app.inject({ method: 'DELETE', url, headers: { authorization: auth } }),
  };
}
