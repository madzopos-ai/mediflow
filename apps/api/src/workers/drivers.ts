/**
 * WhatsApp provider drivers.
 *
 * The rest of the system never talks to a provider directly; it enqueues rows
 * into `outbox` and a driver sends them. That boundary is what makes the
 * simulator usable in development and the Cloud API usable in production
 * without any other code changing.
 */

import { createId, type OutboxStatus } from '@mediflow/shared';

export type WhatsAppDirection = 'inbound' | 'outbound';

export interface WhatsAppMessage {
  from: string;
  to: string;
  body: string;
  /** Provider id, present on everything except the first webhook delivery. */
  providerMessageId: string | null;
  timestamp: string | null;
  raw: unknown;
}

export interface SendRequest {
  to: string;
  body: string;
  /** Correlates the send with its outbox row. */
  idempotencyKey: string;
  previewUrl: boolean;
}

export type SendResult =
  | { ok: true; providerMessageId: string; status: 'sent' | 'queued' }
  | { ok: false; retryable: boolean; error: string; providerMessageId?: string };

export interface WhatsAppDriver {
  readonly name: string;
  send(request: SendRequest): Promise<SendResult>;
  /**
   * Provider status callbacks. `delivered`/`read` are recorded for the audit
   * trail; a `failed` callback moves the message to `failed` but leaves the
   * outbox row for the retry policy to act on.
   */
  onStatus(providerMessageId: string, status: 'sent' | 'delivered' | 'read' | 'failed', at: string): void;
  /** Normalises a provider webhook body into a message, or null if irrelevant. */
  parseInbound(payload: unknown): WhatsAppMessage | null;
  /** Map a clinic's `whatsapp.phoneNumberId` to a driver instance. */
  forPhoneNumber(phoneNumberId: string | null): WhatsAppDriver;
}

/**
 * In-process driver: renders messages into a list instead of sending them.
 *
 * Used by tests and by `WHATSAPP_DRIVER=simulator` in development, so the whole
 * reminder and follow-up flow can be exercised without a provider account.
 */
export class SimulatorDriver implements WhatsAppDriver {
  readonly name = 'simulator';
  readonly sent: SendRequest[] = [];
  readonly statusCallbacks: { providerMessageId: string; status: string; at: string }[] = [];

  send(request: SendRequest): Promise<SendResult> {
    this.sent.push(request);
    return Promise.resolve({ ok: true, providerMessageId: `sim_${this.sent.length}`, status: 'sent' });
  }

  onStatus(providerMessageId: string, status: 'sent' | 'delivered' | 'read' | 'failed', at: string): void {
    this.statusCallbacks.push({ providerMessageId, status, at });
  }

  parseInbound(payload: unknown): WhatsAppMessage | null {
    if (typeof payload !== 'object' || payload === null) return null;
    const body = payload as { from?: unknown; text?: unknown; id?: unknown };
    if (typeof body.from !== 'string' || typeof body.text !== 'string') return null;
    return {
      from: body.from,
      to: 'simulator',
      body: body.text,
      providerMessageId: typeof body.id === 'string' ? body.id : null,
      timestamp: null,
      raw: payload,
    };
  }

  forPhoneNumber(): WhatsAppDriver {
    return this;
  }
}

export interface CloudApiConfig {
  token: string;
  phoneNumberId: string;
  apiVersion: string;
  baseUrl: string;
}

/**
 * Meta WhatsApp Cloud API driver.
 *
 * `fetch` is injected so tests can drive it without network access.
 */
export class CloudApiDriver implements WhatsAppDriver {
  readonly name = 'cloud-api';
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly config: CloudApiConfig,
    fetchImpl: typeof fetch = globalThis.fetch,
  ) {
    this.fetchImpl = fetchImpl;
  }

  async send(request: SendRequest): Promise<SendResult> {
    const url = `${this.config.baseUrl}/${this.config.apiVersion}/${this.config.phoneNumberId}/messages`;
    try {
      const response = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.config.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: request.to,
          type: 'text',
          text: { body: request.body, preview_url: request.previewUrl },
        }),
      });

      if (!response.ok) {
        const detail = await response.text();
        // 4xx other than 429 means the request itself is wrong; retrying it
        // forever would fill the dead-letter table with permanent failures.
        return {
          ok: false,
          retryable: response.status === 429 || response.status >= 500,
          error: `HTTP ${response.status}: ${detail.slice(0, 300)}`,
        };
      }

      const payload = (await response.json()) as { messages?: { id?: string }[] };
      return { ok: true, providerMessageId: payload.messages?.[0]?.id ?? createId('wamid'), status: 'queued' };
    } catch (error) {
      return { ok: false, retryable: true, error: error instanceof Error ? error.message : String(error) };
    }
  }

  onStatus(): void {
    // Status callbacks are persisted by the webhook route, not by the driver.
  }

  parseInbound(payload: unknown): WhatsAppMessage | null {
    if (typeof payload !== 'object' || payload === null) return null;
    const body = payload as {
      entry?: { changes?: { value?: { messages?: unknown[] } }[] }[];
    };
    const change = body.entry?.[0]?.changes?.[0];
    const message = change?.value?.messages?.[0] as
      | { from?: unknown; id?: unknown; text?: { body?: unknown }; timestamp?: unknown; type?: unknown }
      | undefined;
    if (!message || typeof message.from !== 'string' || message.type !== 'text') return null;
    return {
      from: message.from,
      to: this.config.phoneNumberId,
      body: String(message.text?.body ?? ''),
      providerMessageId: typeof message.id === 'string' ? message.id : null,
      timestamp: typeof message.timestamp === 'string' ? message.timestamp : null,
      raw: payload,
    };
  }

  forPhoneNumber(phoneNumberId: string | null): WhatsAppDriver {
    return phoneNumberId && phoneNumberId !== this.config.phoneNumberId
      ? new CloudApiDriver({ ...this.config, phoneNumberId }, this.fetchImpl)
      : this;
  }
}

/**
 * Driver names.
 *
 * There is deliberately no Baileys/Web entry here. The consumer protocol needs
 * a persistent account-level session and can get a number banned, so it lives in
 * the separate gateway service (`@mediflow/baileys-gateway`) that owns the
 * session and drains the Firestore outbox. The API never holds that session: it
 * only reaches the gateway for device pairing, via `GATEWAY_URL`.
 */
export type DriverName = 'simulator' | 'cloud-api';

export interface DriverConfig {
  simulator?: SimulatorDriver;
  cloudApi?: { token: string; phoneNumberId: string; apiVersion?: string };
}

/**
 * Pick a driver from the configured name.
 *
 * `cloud` and `cloud-api` both name the Cloud API, so the env value in
 * `config.ts` and the internal name can drift without breaking anything.
 *
 * A cloud config without a token is a hard error rather than a silent fallback
 * to the simulator: quietly not sending a patient's reminder is the failure mode
 * that actually causes harm.
 */
export function createDriver(name: string, config: DriverConfig): WhatsAppDriver {
  switch (name) {
    case 'simulator':
      return config.simulator ?? new SimulatorDriver();
    case 'cloud':
    case 'cloud-api': {
      if (!config.cloudApi?.token) {
        throw new Error('WHATSAPP_PROVIDER=cloud requires WHATSAPP_CLOUD_TOKEN.');
      }
      return new CloudApiDriver({
        token: config.cloudApi.token,
        phoneNumberId: config.cloudApi.phoneNumberId,
        apiVersion: config.cloudApi.apiVersion ?? 'v20.0',
        baseUrl: 'https://graph.facebook.com',
      });
    }
    default:
      throw new Error(`Unknown WHATSAPP_PROVIDER "${name}". Expected simulator or cloud.`);
  }
}

/** Provider status callback -> stored message status and outbox status. */
export const DELIVERY_STATUS: Record<string, { message: string; outbox: OutboxStatus }> = {
  sent: { message: 'sent', outbox: 'sent' },
  delivered: { message: 'delivered', outbox: 'sent' },
  read: { message: 'read', outbox: 'sent' },
  failed: { message: 'failed', outbox: 'failed' },
};
