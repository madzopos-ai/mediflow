/**
 * Lightweight result / error primitives used across the domain layer.
 * The API converts these into HTTP responses; the PWA renders them inline.
 */

export interface AppErrorShape {
  code: string;
  message: string;
  status: number;
  details?: Record<string, unknown>;
  /** True when retrying the same operation may succeed. */
  retryable?: boolean;
}

export class AppError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: Record<string, unknown> | undefined;
  readonly retryable: boolean;

  constructor(code: string, message: string, status = 400, details?: Record<string, unknown>, retryable = false) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.details = details;
    this.retryable = retryable;
  }

  toShape(): AppErrorShape {
    return {
      code: this.code,
      message: this.message,
      status: this.status,
      ...(this.details ? { details: this.details } : {}),
      retryable: this.retryable,
    };
  }

  static badRequest(message: string, details?: Record<string, unknown>): AppError {
    return new AppError('bad_request', message, 400, details);
  }

  static validation(message: string, details?: Record<string, unknown>): AppError {
    return new AppError('validation_error', message, 422, details);
  }

  static unauthorized(message = 'Authentication required'): AppError {
    return new AppError('unauthorized', message, 401);
  }

  static forbidden(message = 'You do not have permission to perform this action'): AppError {
    return new AppError('forbidden', message, 403);
  }

  static notFound(entity = 'Resource', id?: string): AppError {
    return new AppError('not_found', id ? `${entity} ${id} was not found` : `${entity} was not found`, 404, id ? { id } : undefined);
  }

  static conflict(message: string, details?: Record<string, unknown>): AppError {
    return new AppError('conflict', message, 409, details);
  }

  static rateLimited(message = 'Too many requests', details?: Record<string, unknown>): AppError {
    return new AppError('rate_limited', message, 429, details, true);
  }

  static unavailable(message: string, details?: Record<string, unknown>): AppError {
    return new AppError('service_unavailable', message, 503, details, true);
  }

  static internal(message = 'Internal server error', details?: Record<string, unknown>): AppError {
    return new AppError('internal_error', message, 500, details);
  }
}

export type Result<T, E = AppError> =
  | { ok: true; value: T }
  | { ok: false; error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

export function isOk<T, E>(r: Result<T, E>): r is { ok: true; value: T } {
  return r.ok;
}

export function isErr<T, E>(r: Result<T, E>): r is { ok: false; error: E } {
  return !r.ok;
}

/** Unwrap or throw — handy at the API edge after a `Result`-returning domain call. */
export function unwrap<T, E>(r: Result<T, E>, errorFactory: (e: E) => Error = (e) => new Error(String(e))): T {
  if (r.ok) return r.value;
  throw errorFactory(r.error);
}

export function mapResult<T, U, E>(r: Result<T, E>, fn: (t: T) => U): Result<U, E> {
  return r.ok ? ok(fn(r.value)) : r;
}

/** Collect a list of results into a result of a list, failing on the first error. */
export function collect<T, E>(results: readonly Result<T, E>[]): Result<T[], E> {
  const out: T[] = [];
  for (const r of results) {
    if (!r.ok) return r;
    out.push(r.value);
  }
  return ok(out);
}

export function assertNever(value: never, context = 'Unexpected value'): never {
  throw new Error(`${context}: ${JSON.stringify(value)}`);
}
