/**
 * Authentication and request-scoped tenant context.
 *
 * The critical invariant: **`clinicId` in `request.tenant` comes from the
 * signed session token and nothing else.** Routes never read `clinicId` from a
 * body, query string, or header. Even a public booking route derives its clinic
 * from the clinic slug in the path, and then still validates the bookable
 * service exists for that clinic.
 */

import { randomUUID } from 'node:crypto';

import type { FastifyInstance, FastifyRequest } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import {
  type Capability,
  type MemberRole,
  roleCan,
  ROLE_RANK,
} from '@mediflow/shared';

import type { Config } from '../config.js';
import { scoped, type TenantHandle } from '../db/tenant.js';
import type { Db } from '../db/index.js';

export interface SessionUser {
  id: string;
  clinicId: string;
  email: string;
  fullName: string;
  role: MemberRole;
  locale: string;
  /** Reseller console access: set at login from the users row. */
  isReseller?: boolean;
}

export interface TenantContext {
  user: SessionUser | null;
  clinicId: string;
  db: TenantHandle;
  isAuthenticated: boolean;
  can(capability: Capability): boolean;
  hasRole(minimum: MemberRole): boolean;
}

declare module 'fastify' {
  interface FastifyContextConfig {
    /** Marks a route as reachable without a session (login, public booking). */
    public?: boolean;
  }
  interface FastifyInstance {
    /** A tenant handle for a specific clinic, for cross-tenant admin work. */
    tenantFor(clinicId: string): TenantHandle;
    config: Config;
    database: Db;
  }
  interface FastifyRequest {
    tenant: TenantContext;
  }
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: SessionUser;
    user: SessionUser;
  }
}

/**
 * Attach the tenant context to every request.
 *
 * Unauthenticated requests to a public route still get a context, with a null
 * user, so public endpoints do not need a separate code path.
 */
export function buildTenantContext(db: Db) {
  return async function attachTenant(request: FastifyRequest): Promise<void> {
    // CORS preflight (OPTIONS) carries no credentials by design and is answered
    // by @fastify/cors, not by any route. Rejecting it here would strip the
    // CORS headers from the 401 and make every cross-origin call - including
    // the login page itself - fail with an opaque browser CORS error.
    if (request.method === 'OPTIONS') return;

    let user: SessionUser | null = null;
    try {
      // verify throws when absent or invalid; that is the normal path.
      user = await request.jwtVerify<SessionUser>();
    } catch {
      user = null;
    }

    const isPublic = request.routeOptions.config?.public === true;
    if (!user && !isPublic) {
      // Fail closed: reaching here means a route was registered with neither an
      // auth handler nor a public marker.
      throw httpError(401, 'Authentication required.', 'unauthorized');
    }

    const clinicId = user?.clinicId ?? '';
    request.tenant = {
      user,
      clinicId,
      // A public route has no session, so it gets an inert scope that matches
      // nothing. Public booking resolves its own handle from the clinic slug.
      db: scoped(db, clinicId || '__unauthenticated__'),
      isAuthenticated: user !== null,
      can: (capability) => (user ? roleCan(user.role, capability) : false),
      hasRole: (minimum) => (user ? ROLE_RANK[user.role] >= ROLE_RANK[minimum] : false),
    };
  };
}

export interface HttpError extends Error {
  statusCode: number;
  code: string;
  detail?: unknown;
}

export function httpError(statusCode: number, message: string, code: string, detail?: unknown): HttpError {
  const error = new Error(message) as HttpError;
  error.statusCode = statusCode;
  error.code = code;
  error.detail = detail;
  return error;
}

/** 401 for a missing/invalid token. 403 for a valid token lacking permission. */
export async function requireAuth(request: FastifyRequest): Promise<void> {
  await request.jwtVerify();
}

export function requireCapability(capability: Capability) {
  return async function guard(request: FastifyRequest): Promise<void> {
    await request.jwtVerify();
    if (!request.tenant.can(capability)) {
      // 403 is correct here: the caller is authenticated, just not permitted.
      throw httpError(403, `Missing capability: ${capability}`, 'forbidden', { capability });
    }
  };
}

export function requireRole(minimum: MemberRole) {
  return async function guard(request: FastifyRequest): Promise<void> {
    await request.jwtVerify();
    if (!request.tenant.hasRole(minimum)) {
      throw httpError(403, `Requires role at or above "${minimum}".`, 'forbidden', { minimum });
    }
  };
}

export async function registerAuth(app: FastifyInstance, config: Config, db: Db): Promise<void> {
  await app.register(fastifyJwt, {
    secret: config.jwtSecret,
    sign: { expiresIn: config.jwtExpiresIn },
    // Pinning the algorithm blocks the "alg: none" and RS256->HS256 confusion
    // class of JWT forgery attempts outright.
    verify: { allowedIss: undefined, algorithms: ['HS256'] },
  });

  app.decorate('config', config);
  app.decorate('database', db);
  app.decorate('tenantFor', (clinicId: string) => scoped(db, clinicId));
  // Declared without a value so Fastify does not share one object across
  // requests; the onRequest hook replaces it per request.
  app.decorateRequest('tenant', undefined as unknown as TenantContext);
  app.addHook('onRequest', buildTenantContext(db));
}

export function signSession(app: FastifyInstance, user: SessionUser): string {
  return app.jwt.sign(user);
}

export function newId(): string {
  return randomUUID();
}
