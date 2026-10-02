/**
 * Health and readiness.
 *
 * `/health` is public and cheap. `/ready` additionally checks the database, so
 * a load balancer can keep traffic away while migrations are still running.
 * Neither returns configuration values, only reachability.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createLogger } from '@mediflow/shared';

import { handler, parseBody } from '../http/errors.js';

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
}
