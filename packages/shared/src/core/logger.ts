/**
 * Structured logging for every runtime (API, gateway, web).
 *
 * One tiny dependency-free logger so all three processes emit the same
 * JSON-line shape: `{ ts, level, scope, msg, ...fields }`. Secrets are
 * redacted by key name before anything is written, so a logged request body
 * can never leak a token or password.
 *
 * Error forwarding is pluggable: call `setErrorReporter()` once at boot
 * (API forwards to server logs + optional Sentry/webhook, the web client
 * POSTs to `/system/client-events`). The default reporter is console-only,
 * so the library is safe to use in tests without any wiring.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface ErrorReport {
  scope: string;
  message: string;
  stack?: string;
  url?: string;
  fields?: Record<string, unknown>;
}

type Reporter = (report: ErrorReport) => void;

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let reporter: Reporter | null = null;

export function setErrorReporter(next: Reporter | null): void {
  reporter = next;
}

const SECRET_KEYS = ['token', 'secret', 'password', 'authorization', 'auth', 'code', 'pin'];

export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_KEYS.some((s) => key.toLowerCase().includes(s)) ? '[redacted]' : redact(entry);
    }
    return out;
  }
  return value;
}

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

// The shared package builds without the DOM lib: declare the three console
// sinks we use so the same module compiles for Node and browsers.
declare const console: {
  log(message?: unknown): void;
  warn(message?: unknown): void;
  error(message?: unknown): void;
};

export function createLogger(scope: string, minLevel: LogLevel = 'info'): Logger {
  const emit = (level: LogLevel, message: string, fields: Record<string, unknown> = {}): void => {
    if (RANK[level] < RANK[minLevel]) return;
    const safe = redact(fields) as Record<string, unknown>;
    const line = JSON.stringify({ ts: new Date().toISOString(), level, scope, msg: message, ...safe });
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
    if (level === 'error' && reporter) {
      try {
        reporter({ scope, message, fields: safe });
      } catch {
        // A reporting failure must never break the request being logged.
      }
    }
  };
  return {
    debug: (message, fields) => emit('debug', message, fields),
    info: (message, fields) => emit('info', message, fields),
    warn: (message, fields) => emit('warn', message, fields),
    error: (message, fields) => emit('error', message, fields),
  };
}
