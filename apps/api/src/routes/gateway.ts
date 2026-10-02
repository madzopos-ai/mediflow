/**
 * Gateway pull endpoints: the bridge between the API's outbox and a Baileys
 * gateway running somewhere the API cannot call into.
 *
 * The direction is deliberately reversed from the pairing proxy. Pairing is
 * rare and interactive, so the API calls the gateway. Sending is constant and
 * unattended, so the gateway calls the API: it polls for due WhatsApp rows,
 * sends them over its own session, and reports back. This works with the
 * gateway on a home PC behind NAT, with no tunnel and no inbound firewall
 * rule - the exact shape the old QueueNet bridge proved for years.
 *
 * The poll handler mirrors the worker tick (workers/index.ts) minus delivery:
 * requeue stale locks, schedule due reminders, claim, re-check consent. The
 * gateway is the delivery step. Crash safety comes from the same mechanism:
 * rows the gateway takes but never acks go stale and are requeued.
 */

import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { ApiError, handler, parseBody, parseQuery } from '../http/errors.js';
import { claimDue, dropOptedOut, markFailed, markSent, requeueStale } from '../services/outbox.js';
import { queueDueReminders } from '../services/reminders.js';
import { handleInboundBooking } from '../services/bookingWhats.js';

const pendingQuerySchema = z.object({
  clinicId: z.string().trim().min(1).max(64),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

const ackSchema = z.object({
  clinicId: z.string().trim().min(1).max(64),
  id: z.string().trim().min(1).max(64),
  ok: z.boolean(),
  providerMessageId: z.string().trim().max(128).nullable().optional(),
  error: z.string().trim().max(500).nullable().optional(),
});

const inboundSchema = z.object({
  clinicId: z.string().trim().min(1).max(64),
  from: z.string().trim().min(3).max(32),
  text: z.string().trim().min(1).max(2000),
});

/**
 * The gateway authenticates with the same admin token the pairing proxy uses.
 * Both sides already share it, so no second secret is introduced - and a
 * caller without it learns nothing, because every failure below is a 403.
 */
function requireGateway(request: FastifyRequest, expected: string | null): void {
  if (!expected) {
    // No token configured: the gateway integration is off. 503, not 404,
    // because this is an operator misconfiguration to fix, not a mystery.
    throw new ApiError(
      503,
      'gateway_not_configured',
      'The WhatsApp gateway is not configured on this server.',
    );
  }
  const header = request.headers['authorization'];
  const presented = (Array.isArray(header) ? header[0] : header ?? '').replace(/^Bearer\s+/i, '');
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw ApiError.forbidden('Gateway refused.');
  }
}

function requireClinic(app: FastifyInstance, clinicId: string): void {
  const row = app.database
    .prepare('SELECT id FROM clinics WHERE id = ? AND is_active = 1')
    .get(clinicId) as { id: string } | undefined;
  if (!row) throw ApiError.notFound('Unknown or inactive clinic.');
}

export async function registerGatewayRoutes(app: FastifyInstance): Promise<void> {
  // Public in the auth-plugin sense (no staff session), authenticated by the
  // gateway token inside the handler. Server-to-server by design.
  app.get(
    '/gateway/outbox/pending',
    { config: { public: true } },
    handler(async (request) => {
      requireGateway(request, app.config.gatewayAdminToken);
      const query = parseQuery(request, pendingQuerySchema);
      requireClinic(app, query.clinicId);

      const tenant = app.tenantFor(query.clinicId);
      const now = new Date().toISOString();
      // Same order as the worker tick: stale locks first (a crashed send
      // must become sendable again), then schedule what is due, then claim.
      requeueStale(app.database, query.clinicId, 10, now);
      queueDueReminders(tenant, query.clinicId, now);
      const claimed = claimDue(app.database, query.clinicId, {
        workerId: `gateway:${query.clinicId}`,
        limit: query.limit,
        channel: 'whatsapp',
        now,
      });
      const dropped = new Set(dropOptedOut(tenant, claimed, now).map((m) => m.id));
      const sendable = claimed.filter((m) => !dropped.has(m.id));
      // The gateway needs an address and a body. Nothing else crosses this
      // boundary: no patient names, no templates, no internal ids beyond the
      // outbox row itself.
      return {
        ok: true,
        messages: sendable.map((m) => ({ id: m.id, to: m.to, body: m.body })),
      };
    }),
  );

  app.post(
    '/gateway/outbox/ack',
    { config: { public: true } },
    handler(async (request) => {
      requireGateway(request, app.config.gatewayAdminToken);
      const body = parseBody(request, ackSchema, 'delivery report');
      requireClinic(app, body.clinicId);

      const tenant = app.tenantFor(body.clinicId);
      // Require first: tenant.require scopes by clinic AND 404s on unknown
      // ids, so a gateway cannot ack - or probe - another clinic's rows, and a
      // mistyped id fails loudly instead of reporting a phantom delivery.
      tenant.require('outbox', body.id);
      if (body.ok) {
        markSent(tenant, body.id, body.providerMessageId ?? null);
      } else {
        markFailed(tenant, body.id, body.error || 'Gateway reported failure.');
      }
      return { ok: true };
    }),
  );

  // Inbound patient text, forwarded by the gateway. Runs the booking
  // conversation; anything that is not booking-related is ignored silently so
  // the bot never babbles at ordinary chatter.
  app.post(
    '/gateway/inbound',
    { config: { public: true } },
    handler(async (request) => {
      requireGateway(request, app.config.gatewayAdminToken);
      const body = parseBody(request, inboundSchema, 'inbound message');
      requireClinic(app, body.clinicId);

      const tenant = app.tenantFor(body.clinicId);
      const outcome = handleInboundBooking(
        app.database,
        tenant,
        body.clinicId,
        body.from,
        body.text,
      );
      return { ok: true, action: outcome.action };
    }),
  );
}
