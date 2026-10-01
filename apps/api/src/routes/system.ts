/**
 * Health and readiness.
 *
 * `/health` is public and cheap. `/ready` additionally checks the database, so
 * a load balancer can keep traffic away while migrations are still running.
 * Neither returns configuration values, only reachability.
 */

import type { FastifyInstance } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { createLogger } from '@mediflow/shared';

import { handler, parseBody, ApiError } from '../http/errors.js';
import { bootstrapOwner, BootstrapError } from '../services/bootstrap.js';

const log = createLogger('system');

const clientEventSchema = z.object({
  kind: z.enum(['error', 'rejection']),
  message: z.string().max(500),
  stack: z.string().max(2000).optional(),
  url: z.string().max(500).optional(),
  at: z.string().max(40).optional(),
});

export async function registerSystemRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/health',
    { config: { public: true } },
    handler(async () => ({ status: 'ok', time: new Date().toISOString() })),
  );

  app.get(
    '/ready',
    { config: { public: true } },
    handler(async (_request, reply) => {
      try {
        app.database.prepare('SELECT 1').get();
        return { status: 'ready', database: 'ok' };
      } catch {
        return reply.status(503).send({ status: 'unavailable', database: 'unreachable' });
      }
    }),
  );

  /**
   * Client error intake (P1 observability). Public by design: patient browsers
   * carry no staff session, and the payload is validated, size-capped, and
   * only written to server logs - never to the database. Nothing secret is
   * accepted: the shared logger redacts token-like keys if they ever arrive.
   */
  app.post(
    '/system/client-events',
    { config: { public: true } },
    handler(async (request, reply) => {
      const body = parseBody(request, clientEventSchema, 'client event');
      log.warn('client-error', { kind: body.kind, message: body.message, url: body.url ?? null });
      return reply.status(204).send();
    }),
  );

  registerBootstrapRoute(app);
}

/**
 * One-time first-owner creation over HTTP, for hosts without a shell.
 *
 * Guarded twice: the endpoint 404s as if it did not exist when BOOTSTRAP_TOKEN
 * is unset, and the service refuses whenever any user exists. A leaked token
 * is therefore useless after first use, and brute-forcing it is pointless on
 * a bootstrapped database. Unset BOOTSTRAP_TOKEN (or delete this route) once
 * the owner exists.
 */
function registerBootstrapRoute(app: FastifyInstance): void {
  const bootstrapSchema = z.object({
    token: z.string().min(1).max(256),
    email: z.string().trim().toLowerCase().email().max(254),
    password: z.string().min(1).max(256),
    clinicName: z.string().trim().min(2).max(160).optional(),
  });

  app.post(
    '/system/bootstrap',
    { config: { public: true } },
    handler(async (request, reply) => {
      const configured = app.config.bootstrapToken;
      if (!configured) {
        // Indistinguishable from an unknown route: no oracle for scanners.
        return reply.status(404).send({ error: { code: 'not_found', message: 'No route for POST /system/bootstrap.' } });
      }
      const body = parseBody(request, bootstrapSchema, 'bootstrap request');

      const expected = Buffer.from(configured, 'utf8');
      const actual = Buffer.from(body.token, 'utf8');
      const match =
        expected.length === actual.length && timingSafeEqual(expected, actual);
      if (!match) {
        throw ApiError.forbidden('Bootstrap refused.');
      }

      try {
        const result = await bootstrapOwner(app.database, {
          email: body.email,
          password: body.password,
          clinicName: body.clinicName,
        });
        request.log.info({ email: result.ownerEmail }, 'Bootstrap created the first owner.');
        return { ok: true, clinicId: result.clinicId, ownerEmail: result.ownerEmail };
      } catch (error) {
        if (error instanceof BootstrapError) {
          // 400 for bad input, 409 when the database is already bootstrapped.
          // The distinction is safe: a non-empty database answers 409 to any
          // caller, so nothing about registered addresses leaks.
          const status = error.code === 'already_bootstrapped' ? 409 : 400;
          throw new ApiError(status, error.code, error.message);
        }
        throw error;
      }
    }),
  );
}
