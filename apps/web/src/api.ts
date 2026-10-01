/**
 * API client.
 *
 * Offline behaviour is explicit:
 *   - GETs are cached in localStorage on success and served stale when the
 *     network is unreachable, so previously opened lists stay readable.
 *   - Mutations (POST/PATCH/PUT/DELETE) are queued in localStorage when the
 *     device is offline and replayed FIFO on reconnect. They are never queued
 *     on 4xx/5xx: a rejected write must surface, not retry silently.
 */

export interface ApiErrorShape {
  error?: { code?: string; message?: string };
}

export class ApiRequestError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export class OfflineQueuedError extends Error {
  constructor() {
    super('queued-offline');
  }
}

export interface QueuedMutation {
  id: string;
  method: string;
  path: string;
  body: unknown;
  queuedAt: string;
}

const BASE = (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:4000';
const TOKEN_KEY = 'mf_token';
const USER_KEY = 'mf_user';
const QUEUE_KEY = 'mf_queue';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setSession(token: string, user: unknown): void {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}

export function clearSession(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}

export function getUser<T = { fullName?: string; email?: string } | null>(): T {
  try {
    return JSON.parse(localStorage.getItem(USER_KEY) ?? 'null') as T;
  } catch {
    return null as T;
  }
}

function cacheKey(path: string): string {
  return `mf_get:${path}`;
}

export function readCached<T>(path: string): T | null {
  try {
    const raw = localStorage.getItem(cacheKey(path));
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeCached(path: string, value: unknown): void {
  try {
    localStorage.setItem(cacheKey(path), JSON.stringify({ at: new Date().toISOString(), value }));
  } catch {
    // Storage pressure must never break a successful request.
  }
}

export function readQueue(): QueuedMutation[] {
  try {
    return JSON.parse(localStorage.getItem(QUEUE_KEY) ?? '[]') as QueuedMutation[];
  } catch {
    return [];
  }
}

function writeQueue(queue: QueuedMutation[]): void {
  localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
}

export function enqueueMutation(method: string, path: string, body: unknown): void {
  const queue = readQueue();
  queue.push({
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    method,
    path,
    body,
    queuedAt: new Date().toISOString(),
  });
  writeQueue(queue);
  window.dispatchEvent(new CustomEvent('mf:queue-changed'));
}

async function send(method: string, path: string, body: unknown, token: string): Promise<Response> {
  // A bodiless request must not claim a JSON content-type: Fastify rejects an
  // empty body advertised as JSON with a 400 before any route runs.
  const hasBody = body !== undefined;
  return fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(hasBody ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: hasBody ? JSON.stringify(body) : null,
  });
}

export interface ApiOptions {
  /**
   * Skip the localStorage GET cache entirely.
   *
   * Needed for anything that is expected to change within a session. The QR for
   * device linking is the case that matters: Baileys rotates it roughly every
   * 30s, and a cached response would show a code that can no longer scan while
   * looking perfectly valid.
   */
  noCache?: boolean;
  /**
   * Allow a queued mutation instead of failing.
   *
   * Off by default. Queuing a request whose whole purpose is to take effect
   * *now* (requesting a pairing code) would report success and do nothing.
   */
  queueable?: boolean;
}

export async function api<T>(
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
  options: ApiOptions = {},
): Promise<T> {
  const token = getToken();
  if (!token) throw new ApiRequestError(401, 'unauthorized', 'Not signed in.');

  let response: Response;
  try {
    response = await send(method, path, body, token);
  } catch {
    // Network failure, not a server rejection.
    if (method === 'GET') {
      const cached = options.noCache ? null : readCached<{ value: T }>(path);
      if (cached) return cached.value;
      throw new ApiRequestError(0, 'offline', 'No connection and nothing cached.');
    }
    // A non-queueable write reports the outage instead of silently deferring.
    if (options.queueable === false) {
      throw new ApiRequestError(0, 'offline', 'No connection.');
    }
    enqueueMutation(method, path, body);
    throw new OfflineQueuedError();
  }

  if (response.status === 401) {
    clearSession();
    window.location.hash = '#/login';
    throw new ApiRequestError(401, 'unauthorized', 'Session expired.');
  }

  if (!response.ok) {
    let code = 'request_failed';
    let message = `Request failed (${response.status}).`;
    try {
      const parsed = (await response.json()) as ApiErrorShape;
      if (parsed.error?.code) code = parsed.error.code;
      if (parsed.error?.message) message = parsed.error.message;
    } catch {
      // Keep the generic message when the body is not JSON.
    }
    throw new ApiRequestError(response.status, code, message);
  }

  const data = (await response.json()) as T;
  if (method === 'GET' && !options.noCache) writeCached(path, data);
  return data;
}

/** Replay queued mutations in order. Stops at the first failure. */
export async function syncQueue(): Promise<{ done: number; failed: number }> {
  const token = getToken();
  if (!token) return { done: 0, failed: 0 };
  const queue = readQueue();
  let done = 0;
  for (const item of queue) {
    let response: Response;
    try {
      response = await send(item.method, item.path, item.body, token);
    } catch {
      break; // Still offline; keep the rest queued.
    }
    if (!response.ok) {
      if (response.status >= 400 && response.status < 500) {
        // The server rejected this write; drop it rather than retrying forever.
        writeQueue(readQueue().filter((q) => q.id !== item.id));
        window.dispatchEvent(new CustomEvent('mf:queue-changed'));
        continue;
      }
      break;
    }
    writeQueue(readQueue().filter((q) => q.id !== item.id));
    done += 1;
  }
  window.dispatchEvent(new CustomEvent('mf:queue-changed'));
  return { done, failed: readQueue().length };
}

export async function loginRequest(email: string, password: string): Promise<{ token: string; user: unknown }> {
  const response = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!response.ok) {
    throw new ApiRequestError(response.status, 'unauthorized', 'Sign-in failed.');
  }
  return (await response.json()) as { token: string; user: unknown };
}

/**
 * Asks the API to email a reset link.
 *
 * The API answers 200 whether or not the address is registered, so the UI must
 * show the same confirmation either way. Showing a different message for a
 * known address would turn this form into a way to find out who works here.
 */
export async function requestPasswordReset(email: string): Promise<void> {
  const response = await fetch(`${BASE}/auth/password/forgot`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { code?: string; message?: string } | null;
    throw new ApiRequestError(
      response.status,
      body?.code ?? 'reset_failed',
      body?.message ?? 'Password reset is unavailable.',
    );
  }
}

/** True when a reset link is still usable, so the page can say so up front. */
export async function checkPasswordResetToken(token: string): Promise<boolean> {
  const response = await fetch(
    `${BASE}/auth/password/reset?token=${encodeURIComponent(token)}`,
  );
  if (response.ok) return true;
  const body = await response.json().catch(() => null) as { code?: string } | null;
  throw new ApiRequestError(
    response.status,
    body?.code ?? 'reset_invalid',
    'This reset link is no longer valid.',
  );
}

/** Redeems a reset token and sets the new password. */
export async function redeemPasswordResetToken(token: string, password: string): Promise<void> {
  const response = await fetch(`${BASE}/auth/password/reset`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token, password }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { code?: string; message?: string } | null;
    throw new ApiRequestError(
      response.status,
      body?.code ?? 'reset_invalid',
      body?.message ?? 'This reset link is no longer valid.',
    );
  }
}

/**
 * Exchange a Firebase ID token for an API session.
 *
 * The API verifies the token, reads the staff doc (role + clinicId) and
 * auto-provisions its own rows, so a doctor who signed up on Firebase never
 * needs a second account. No bearer token here: the ID token *is* the proof.
 */
export async function exchangeFirebaseSession(idToken: string): Promise<{ token: string; user: unknown }> {
  const response = await fetch(`${BASE}/auth/firebase`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ idToken }),
  });
  if (!response.ok) {
    let message = 'Sign-in failed.';
    try {
      const parsed = (await response.json()) as ApiErrorShape;
      if (parsed.error?.message) message = parsed.error.message;
    } catch {
      // Keep the generic message when the body is not JSON.
    }
    throw new ApiRequestError(response.status, 'unauthorized', message);
  }
  return (await response.json()) as { token: string; user: unknown };
}
