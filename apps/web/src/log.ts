/**
 * Client-side error tracking (P1 observability).
 *
 * Captures `window.onerror` and `unhandledrejection`, keeps the last 50
 * entries in localStorage (`mf_errlog`) for on-device debugging, and
 * best-effort POSTs each event to `POST /system/client-events` where the API
 * writes it into structured server logs. Reporting never throws and never
 * blocks the UI: a logging failure is swallowed, and payloads are capped.
 *
 * Install once at boot from main.ts: `installClientLogging()`.
 */

const KEY = 'mf_errlog';
const MAX_BUFFER = 50;

function base(): string {
  return (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:4000';
}

export interface ClientEvent {
  kind: 'error' | 'rejection';
  message: string;
  stack?: string;
  url: string;
  at: string;
}

function buffer(event: ClientEvent): void {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '[]') as ClientEvent[];
    raw.push(event);
    localStorage.setItem(KEY, JSON.stringify(raw.slice(-MAX_BUFFER)));
  } catch {
    // Storage pressure must never break the app being debugged.
  }
}

export function readErrorBuffer(): ClientEvent[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '[]') as ClientEvent[];
  } catch {
    return [];
  }
}

async function forward(event: ClientEvent): Promise<void> {
  try {
    const body = JSON.stringify({ ...event, message: event.message.slice(0, 500), stack: event.stack?.slice(0, 2000) });
    await fetch(`${base()}/system/client-events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      keepalive: true,
    });
  } catch {
    // Offline or unreachable backend: the local buffer keeps the event.
  }
}

export function reportClientError(error: unknown, kind: ClientEvent['kind'] = 'error'): void {
  const stack = error instanceof Error ? error.stack : undefined;
  const event: ClientEvent = {
    kind,
    message: error instanceof Error ? error.message : String(error),
    ...(stack ? { stack } : {}),
    url: window.location.href,
    at: new Date().toISOString(),
  };
  buffer(event);
  void forward(event);
}

let installed = false;

export function installClientLogging(): void {
  if (installed) return;
  installed = true;
  window.addEventListener('error', (event) => {
    reportClientError(event.error ?? event.message, 'error');
  });
  window.addEventListener('unhandledrejection', (event) => {
    reportClientError(event.reason, 'rejection');
  });
}
