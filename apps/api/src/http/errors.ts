/**
 * HTTP error type and validation helpers.
 *
 * A single error shape is returned to every client:
 *   { error: { code, message, detail? } }
 *
 * `detail` carries field-level validation problems only. It never carries a
 * stack trace, an SQL string, or a message from a caught exception, because
 * those leak internals that help an attacker probe the schema.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import { z, type ZodTypeAny } from 'zod';

export class ApiError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly detail: unknown;

  constructor(statusCode: number, code: string, message: string, detail?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.code = code;
    this.detail = detail;
  }

  static badRequest(message: string, detail?: unknown): ApiError {
    return new ApiError(400, 'bad_request', message, detail);
  }

  static unauthorized(message = 'Authentication required.'): ApiError {
    return new ApiError(401, 'unauthorized', message);
  }

  static forbidden(message = 'You do not have permission to do that.'): ApiError {
    return new ApiError(403, 'forbidden', message);
  }

  static notFound(message = 'Not found.'): ApiError {
    return new ApiError(404, 'not_found', message);
  }

  static conflict(message: string, detail?: unknown): ApiError {
    return new ApiError(409, 'conflict', message, detail);
  }

  static tooManyRequests(message = 'Too many requests.'): ApiError {
    return new ApiError(429, 'rate_limited', message);
  }
}

export interface FieldIssue {
  path: string;
  message: string;
}

/** Flatten a ZodError into `detail` without leaking the schema shape. */
function issuesOf(error: z.ZodError): FieldIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.join('.') || '(root)',
    message: issue.message,
  }));
}

/** Parse a value or throw a 400 with per-field messages. */
export function parseOrThrow<T extends ZodTypeAny>(schema: T, value: unknown, what = 'request'): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw ApiError.badRequest(`Invalid ${what}.`, issuesOf(result.error));
  }
  return result.data;
}

export function parseBody<T extends ZodTypeAny>(request: FastifyRequest, schema: T, what = 'request body'): z.infer<T> {
  return parseOrThrow(schema, request.body ?? {}, what);
}

export function parseQuery<T extends ZodTypeAny>(request: FastifyRequest, schema: T): z.infer<T> {
  return parseOrThrow(schema, request.query ?? {}, 'query parameters');
}

export function parseParams<T extends ZodTypeAny>(request: FastifyRequest, schema: T): z.infer<T> {
  return parseOrThrow(schema, request.params ?? {}, 'path parameters');
}

/** Wrap an async handler so a rejected promise reaches the error handler. */
export function handler<T>(
  fn: (request: FastifyRequest, reply: FastifyReply) => Promise<T>,
): (request: FastifyRequest, reply: FastifyReply) => Promise<unknown> {
  return async (request, reply) => fn(request, reply);
}

// Reusable field schemas.
export const idSchema = z.string().trim().min(1).max(64);
export const isoDateSchema = z
  .string()
  .trim()
  .refine((v) => !Number.isNaN(Date.parse(v)), 'Must be an ISO-8601 timestamp.');
export const dateKeySchema = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be a yyyy-mm-dd date key.');
export const timeSchema = z.string().trim().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Must be HH:mm.');
export const phoneSchema = z.string().trim().min(6).max(24);
export const moneyMinorSchema = z.number().int().min(0).max(1_000_000_000);

/** Pagination with a hard cap so a client cannot request the whole table. */
export const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
