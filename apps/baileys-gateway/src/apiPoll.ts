/**
 * API outbox polling: how queued WhatsApp messages reach a gateway the API
 * cannot call into.
 *
 * Normal direction here is reversed on purpose. The API owns the outbox
 * (SQLite, with priorities, dedupe and consent), but when the gateway sits on
 * a home PC behind NAT the API has no route to it. So the gateway calls the
 * API instead: poll for due rows, send over its own session, report back.
 * Outbound HTTPS from anywhere, no tunnel, no inbound firewall rule - the
 * shape the old QueueNet bridge proved for years.
 *
 * Crash safety mirrors the worker tick: rows are claimed server-side before
 * they are handed out, so a gateway that dies mid-send leaves them
 * `processing`, and they go stale and requeue. The one rule this loop never
 * breaks: a row is only acked after a send was actually attempted. Anything
 * skipped (disconnected socket, malformed row) is left alone, never failed,
 * so attempts are spent on real failures, not on outages.
 */

export interface ApiPollConfig {
  /** API origin, e.g. http://localhost:4000. Empty disables polling. */
  apiUrl: string;
  /** Shared secret, sent as a Bearer token. Same value as GATEWAY_ADMIN_TOKEN. */
  adminToken: string;
  clinicId: string;
  intervalMs: number;
  isConnected: () => boolean;
  /** Sends one message; resolves to the provider's message id. */
  send: (to: string, body: string) => Promise<string | null>;
  log: (message: string) => void;
  logError: (message: string) => void;
}

interface PendingRow {
  id: string;
  to: string;
  body: string;
}

/**
 * Backoff between polls after consecutive failures, so an API outage logs
 * once and then goes quiet instead of writing a line every 15 seconds for
 * hours. Caps at 5 minutes; any success resets to the base interval.
 */
export function pollDelayMs(baseMs: number, consecutiveFailures: number): number {
  if (consecutiveFailures <= 0) return baseMs;
  return Math.min(baseMs * 2 ** consecutiveFailures, 5 * 60_000);
}

async function getJson(url: string, token: string): Promise<unknown> {
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`API ${res.status} on ${new URL(url).pathname}`);
  return (await res.json()) as unknown;
}

async function postJson(url: string, token: string, body: Record<string, unknown>): Promise<void> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`API ${res.status} on ${new URL(url).pathname}`);
}

function asRows(value: unknown): PendingRow[] {
  if (typeof value !== 'object' || value === null) return [];
  const messages = (value as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return [];
  return messages.flatMap((m): PendingRow[] => {
    if (typeof m !== 'object' || m === null) return [];
    const row = m as Record<string, unknown>;
    if (typeof row['id'] !== 'string' || typeof row['to'] !== 'string' || typeof row['body'] !== 'string') {
      return [];
    }
    return [{ id: row['id'], to: row['to'], body: row['body'] }];
  });
}

/**
 * Starts the poll loop. Returns a stop function. When `apiUrl` is empty the
 * loop never starts: pairing-only deployments should not log errors about an
 * integration nobody configured.
 */
export function startApiPoll(config: ApiPollConfig): () => void {
  const prefix = `[${config.clinicId}] api-poll`;
  if (!config.apiUrl) {
    config.log(`${prefix} disabled: set MEDIFLOW_API_URL to deliver API outbox rows.`);
    return () => undefined;
  }
  const base = config.apiUrl.replace(/\/+$/, '');
  let stopped = false;
  let failures = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  async function ack(id: string, ok: boolean, extra: Record<string, unknown>): Promise<void> {
    await postJson(`${base}/gateway/outbox/ack`, config.adminToken, {
      clinicId: config.clinicId,
      id,
      ok,
      ...extra,
    });
  }

  async function tick(): Promise<void> {
    if (stopped) return;
    try {
      const payload = await getJson(
        `${base}/gateway/outbox/pending?clinicId=${encodeURIComponent(config.clinicId)}&limit=25`,
        config.adminToken,
      );
      failures = 0;
      for (const row of asRows(payload)) {
        if (stopped) return;
        if (!config.isConnected()) return; // leave rows processing; they requeue
        try {
          const providerId = await config.send(row.to, row.body);
          await ack(row.id, true, { providerMessageId: providerId });
          config.log(`${prefix} sent ${row.id} to ${row.to}`);
        } catch (error) {
          await ack(row.id, false, {
            error: (error instanceof Error ? error.message : String(error)).slice(0, 300),
          });
          config.logError(`${prefix} send failed for ${row.id}, reported.`);
        }
      }
    } catch (error) {
      failures += 1;
      config.logError(
        `${prefix} poll failed (${failures} in a row): ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      if (!stopped) timer = setTimeout(() => void tick(), pollDelayMs(config.intervalMs, failures));
    }
  }

  void tick();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
