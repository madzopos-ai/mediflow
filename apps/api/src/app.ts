/**
 * Application assembly.
 *
 * `buildApp` takes an already-open database so tests can pass `:memory:` and
 * the bootstrap in `index.ts` can pass a file. Nothing here opens a connection
 * or reads process.env, which is what makes the whole API testable without a
 * running server.
 */

import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { createLogger, setErrorReporter } from '@mediflow/shared';

import type { Config } from './config.js';
import { loadConfig } from './config.js';
import { openDatabase, type Db } from './db/index.js';
import { registerAuth } from './auth/plugin.js';
import { ApiError } from './http/errors.js';

import { registerAuthRoutes } from './routes/auth.js';
import { registerClinicRoutes } from './routes/clinic.js';
import { registerPatientRoutes } from './routes/patients.js';
import { registerAppointmentRoutes } from './routes/appointments.js';
import { registerScheduleRoutes } from './routes/schedule.js';
import { registerWaitlistRoutes } from './routes/waitlist.js';
import { registerMessagingRoutes } from './routes/messaging.js';
import { registerGatewayRoutes } from './routes/gateway.js';
import { registerCareRoutes } from './routes/care.js';
import { registerRecordRoutes } from './routes/records.js';
import { registerVisitFlowRoutes } from './routes/visitflow.js';
import { registerResellerRoutes } from './routes/reseller.js';
import { registerJoinRoutes } from './routes/join.js';
import { registerNetworkRoutes } from './routes/network.js';
import { registerPatientAppRoutes } from './routes/patientapp.js';
import { registerFinanceRoutes } from './routes/finance.js';
import { registerDashboardRoutes } from './routes/dashboard.js';
import { registerPublicRoutes } from './routes/public.js';
import { registerSystemRoutes } from './routes/system.js';
import { registerPharmacyRoutes } from './routes/pharmacy.js';
import { registerLabRoutes } from './routes/lab.js';

export interface BuildAppOptions {
  db: Db;
  config: Config;
  /**
   * Background workers are deliberately not wired up here.
   *
   * The HTTP layer should not own a background loop: a send that takes thirty
   * seconds must not hold a request open, and a test must never have a timer
   * racing it. `src/index.ts` starts the worker, `src/worker.ts` runs it
   * standalone, and tests call `Worker.tick()` explicitly.
   */
}

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const { db, config } = options;
  const log = createLogger('api');

  // P1 observability: 5xx (and client-reported errors) are structured-logged
  // and optionally forwarded to an error webhook (ERROR_WEBHOOK_URL, e.g. a
  // Sentry-compatible receiver). Fire-and-forget: reporting never blocks the
  // request and never throws.
  const webhook = process.env.ERROR_WEBHOOK_URL?.trim() || null;
  setErrorReporter((report) => {
    log.error(report.message, { scope: report.scope, ...(report.fields ?? {}) });
    if (webhook) {
      void fetch(webhook, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...report, at: new Date().toISOString() }).slice(0, 8000),
      }).catch(() => undefined);
    }
  });

  const app = Fastify({
    logger: { level: config.logLevel },
    // A 12 KB JWT plus a booking payload should never approach this; the limit
    // exists to reject a hostile oversized body early.
    bodyLimit: config.maxUploadBytes,
    trustProxy: config.isProduction,
    disableRequestLogging: config.nodeEnv === 'test',
  });

  // Auth must be registered before any route so the onRequest hook that builds
  // `request.tenant` is installed first.
  await registerAuth(app, config, db);

  await app.register(cors, {
    origin: config.corsOrigins.length > 0 ? config.corsOrigins : false,
    credentials: true,
    // The browser sends this on every request when behind ngrok (it skips
    // ngrok's interstitial page). Listed explicitly so preflights never
    // depend on a framework default.
    allowedHeaders: ['Content-Type', 'Authorization', 'ngrok-skip-browser-warning'],
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof ApiError) {
      return reply.status(error.statusCode).send({
        error: { code: error.code, message: error.message, ...(error.detail ? { detail: error.detail } : {}) },
      });
    }

    const statusCode =
      typeof error.statusCode === 'number' && error.statusCode >= 400 && error.statusCode < 600
        ? error.statusCode
        : 500;

    if (statusCode >= 500) {
      request.log.error({ err: error }, 'Unhandled error');
      log.error('unhandled-error', {
        method: request.method,
        url: request.url,
        statusCode,
        message: error.message?.slice(0, 300),
      });
    }

    // Only pass the underlying message through for 4xx, where it is a client
    // error the caller can act on. A 5xx message may contain a SQL fragment or
    // a file path.
    const message =
      statusCode >= 500 ? 'Internal server error.' : (error.message || 'Request failed.');

    const code =
      statusCode === 400 ? 'bad_request' : statusCode === 401 ? 'unauthorized' : statusCode === 403 ? 'forbidden' : statusCode === 404 ? 'not_found' : statusCode === 409 ? 'conflict' : statusCode >= 500 ? 'internal_error' : 'request_failed';

    return reply.status(statusCode).send({ error: { code, message } });
  });

  app.setNotFoundHandler((request, reply) => {
    void reply.status(404).send({
      error: { code: 'not_found', message: `No route for ${request.method} ${request.url}.` },
    });
  });

  await app.register(registerSystemRoutes);
  await app.register(async (instance) => {
    await registerAuthRoutes(instance, { config, db });
  });
  await app.register(registerClinicRoutes);
  await app.register(registerPatientRoutes);
  await app.register(registerAppointmentRoutes);
  await app.register(registerScheduleRoutes);
  await app.register(registerWaitlistRoutes);
  // Wrapped rather than passed as plugin options: Fastify types the options
  // bag as its own `Config`, and our Config's `logLevel` is a plain string that
  // collides with Fastify's `LevelWithSilent`.
  await app.register(async (instance) => {
    await registerMessagingRoutes(instance, config);
  });
  // Gateway pull endpoints: no session, token-authenticated. The gateway
  // polls these; the API never calls out to the gateway except for pairing.
  await app.register(registerGatewayRoutes);
  await app.register(registerCareRoutes);
  await app.register(registerRecordRoutes);
  await app.register(registerVisitFlowRoutes);
  await app.register(registerResellerRoutes);
  await app.register(registerJoinRoutes);
  await app.register(registerNetworkRoutes);
  await app.register(registerPatientAppRoutes);
  await app.register(registerFinanceRoutes);
  await app.register(registerDashboardRoutes);
  await app.register(registerPublicRoutes);
  // Inert future modules: status probes live, operations answer 410.
  await app.register(registerPharmacyRoutes);
  await app.register(registerLabRoutes);

  return app;
}

/** Convenience for scripts and tests that need a fully wired instance. */
export async function buildTestApp(
  overrides: Partial<Config> = {},
): Promise<{ app: FastifyInstance; db: Db; config: Config }> {
  const config: Config = {
    ...loadConfig({
      NODE_ENV: 'test',
      JWT_SECRET: 'test-secret-that-is-definitely-long-enough-32',
      ENCRYPTION_KEY: 'test-encryption-key-32-bytes-long!!!!',
      DATABASE_FILE: ':memory:',
    }),
    ...overrides,
  };
  const db = openDatabase({ file: config.databaseFile });
  const app = await buildApp({ db, config });
  return { app, db, config };
}
