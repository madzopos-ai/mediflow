/**
 * Lab module - INERT SCAFFOLD.
 *
 * Tables exist (migration 20) and types live in `@mediflow/shared`, but the
 * module is switched OFF: every operational endpoint answers 410 with
 * `{ enabled: false }` unless `PHARMACY_LAB_ENABLED=1` is set. Only the
 * status probe and the (empty until seeded) catalog read work unconditionally
 * so the admin console can render the disabled placeholder. Activation = set
 * the env flag + build the UI.
 */

import type { FastifyInstance } from 'fastify';

import { requireCapability } from '../auth/plugin.js';
import { handler } from '../http/errors.js';

const ENABLED = process.env['PHARMACY_LAB_ENABLED'] === '1';

function disabled(): { enabled: false; module: string } {
  return { enabled: false as const, module: 'lab' };
}

export async function registerLabRoutes(app: FastifyInstance): Promise<void> {
  app.get('/lab/status', { preHandler: requireCapability('clinical:read') }, handler(async () => ({
    enabled: ENABLED,
    module: 'lab' as const,
  })));

  const inert = { preHandler: requireCapability('clinical:read') };
  app.get('/lab/catalog', inert, handler(async (_request, reply) => reply.status(410).send(disabled())));
  app.get('/lab/orders', inert, handler(async (_request, reply) => reply.status(410).send(disabled())));
  app.post('/lab/orders', inert, handler(async (_request, reply) => reply.status(410).send(disabled())));
  app.post('/lab/results', inert, handler(async (_request, reply) => reply.status(410).send(disabled())));
}
