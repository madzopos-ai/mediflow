/**
 * Small accessors that keep route bodies readable.
 *
 * `tenantOf` exists so a route reads `tenantOf(request).all(...)` instead of
 * reaching for `request.tenant.db` a dozen times. It is a pure getter: it
 * cannot change the scope.
 */

import type { FastifyRequest } from 'fastify';

import type { TenantHandle } from '../db/tenant.js';

export function tenantOf(request: FastifyRequest): TenantHandle {
  return request.tenant.db;
}

export function clinicIdOf(request: FastifyRequest): string {
  return request.tenant.clinicId;
}

export function userIdOf(request: FastifyRequest): string | null {
  return request.tenant.user?.id ?? null;
}
