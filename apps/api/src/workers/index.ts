/**
 * Background worker.
 *
 * A single interval loop rather than a job queue. SQLite serialises write
 * transactions, and every job here is short and idempotent, so a claim/update
 * pair inside one transaction is enough to stop two workers double-sending.
 * Adding Redis would add a second datastore to keep consistent for no benefit at
 * clinic scale.
 *
 * The worker is started by `src/worker.ts` as its own process so a long send
 * cannot delay an HTTP response.
 */

import { createId } from '@mediflow/shared';

import type { Db } from '../db/index.js';
import { scoped, type TenantHandle } from '../db/tenant.js';
import type { OutboxMessage } from '@mediflow/shared';
import { claimDue, dropOptedOut, markFailed, markSent, requeueStale } from '../services/outbox.js';
import { queueDueReminders } from '../services/reminders.js';
import { releaseExpiredHolds } from '../services/appointments.js';
import { createMessage, ensureThread, threadKey } from '../services/threads.js';
import { createDriver, type SimulatorDriver, type WhatsAppDriver } from './drivers.js';

export interface WorkerOptions {
  db: Db;
  driverName: string;
  /** Identifies this process in `outbox.locked_by`. */
  workerId?: string;
  intervalMs?: number;
  batchSize?: number;
  /** Rows left `processing` longer than this are assumed abandoned. */
  staleAfterMinutes?: number;
  simulator?: SimulatorDriver;
  whatsapp?: { token: string; phoneNumberId: string; apiVersion?: string };
  /** Test seam: prevents a real timer from being scheduled. */
  autostart?: boolean;
}

export interface TickResult {
  clinics: number;
  claimed: number;
  sent: number;
  failed: number;
  droppedOptedOut: number;
  remindersQueued: number;
  holdsReleased: number;
  requeuedStale: number;
}

const DEFAULT_INTERVAL_MS = 5_000;
const DEFAULT_BATCH = 50;
const DEFAULT_STALE_MINUTES = 10;

export class Worker {
  readonly id: string;
  private readonly driver: WhatsAppDriver;
  private readonly intervalMs: number;
  private readonly batchSize: number;
  private readonly staleAfterMinutes: number;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly options: WorkerOptions) {
    this.id = options.workerId ?? `worker-${createId('w').slice(-8)}`;
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.batchSize = options.batchSize ?? DEFAULT_BATCH;
    this.staleAfterMinutes = options.staleAfterMinutes ?? DEFAULT_STALE_MINUTES;
    this.driver = createDriver(options.driverName, {
      simulator: options.simulator,
      cloudApi: options.whatsapp,
    });
  }

  get whatsapp(): WhatsAppDriver {
    return this.driver;
  }

  /**
   * One pass over every active clinic's pending work.
   *
   * Never throws. A worker that dies stops every reminder in every clinic, so a
   * failing step is logged and the pass continues.
   */
  async tick(now = new Date().toISOString()): Promise<TickResult> {
    const result: TickResult = {
      clinics: 0,
      claimed: 0,
      sent: 0,
      failed: 0,
      droppedOptedOut: 0,
      remindersQueued: 0,
      holdsReleased: 0,
      requeuedStale: 0,
    };

    const clinics = this.options.db
      .prepare('SELECT id FROM clinics WHERE is_active = 1 ORDER BY id')
      .all() as { id: string }[];

    for (const clinic of clinics) {
      result.clinics += 1;
      const tenant = scoped(this.options.db, clinic.id);

      // A row left `processing` by a crashed worker would otherwise never be
      // retried, because the claim only looks at `pending`.
      try {
        result.requeuedStale += requeueStale(this.options.db, clinic.id, this.staleAfterMinutes, now);
      } catch (error) {
        this.log('stale requeue failed', clinic.id, error);
      }

      try {
        result.remindersQueued += queueDueReminders(tenant, clinic.id, now);
      } catch (error) {
        this.log('reminder dispatch failed', clinic.id, error);
      }

      try {
        result.holdsReleased += releaseExpiredHolds(tenant, clinic.id).length;
      } catch (error) {
        this.log('hold release failed', clinic.id, error);
      }

      try {
        const claimed = claimDue(this.options.db, clinic.id, { workerId: this.id, limit: this.batchSize, now });
        result.claimed += claimed.length;

        // Consent is re-checked at send time, not only at enqueue time: a patient
        // may opt out in the hours between a message being scheduled and sent.
        const dropped = new Set(dropOptedOut(tenant, claimed, now).map((m) => m.id));
        result.droppedOptedOut += dropped.size;

        for (const message of claimed) {
          if (dropped.has(message.id)) continue;
          if (await this.deliver(tenant, clinic.id, message, now)) result.sent += 1;
          else result.failed += 1;
        }
      } catch (error) {
        this.log('outbox delivery failed', clinic.id, error);
      }
    }

    return result;
  }

  /**
   * Send one claimed row and record the outcome.
   *
   * `safetyCritical` messages bypass the opt-out sweep above: a patient who has
   * unsubscribed from reminders is still entitled to be told that their critical
   * blood-pressure reading came through.
   */
  private async deliver(tenant: TenantHandle, clinicId: string, message: OutboxMessage, now: string): Promise<boolean> {
    if (message.channel !== 'whatsapp') {
      // Only WhatsApp has a driver. Anything else is dead-lettered rather than
      // retried forever against a channel we cannot send on.
      markFailed(tenant, message.id, `No driver for channel "${message.channel}".`, now);
      return false;
    }

    const driver = this.driver;
    const result = await driver.send({
      to: message.to,
      body: message.body,
      idempotencyKey: message.dedupeKey ?? message.id,
      // No link preview: a reminder contains a patient identifier and a
      // clinic name, which should not be rendered as a preview card.
      previewUrl: false,
    });

    if (!result.ok) {
      markFailed(tenant, message.id, result.error, now);
      return false;
    }

    markSent(tenant, message.id, result.providerMessageId, now);
    this.mirrorToConversation(tenant, clinicId, message, result.providerMessageId, now);
    return true;
  }

  /**
   * Copy a sent message into the conversation view.
   *
   * The outbox is the delivery mechanism; `messages` is what staff read. A
   * failure here must not mark the send as failed, since the message is already
   * with the provider.
   */
  private mirrorToConversation(
    tenant: TenantHandle,
    clinicId: string,
    message: OutboxMessage,
    providerMessageId: string,
    now: string,
  ): void {
    if (!message.patientId) return;
    try {
      const threadId = ensureThread(tenant, clinicId, message.patientId, threadKey(message.patientId), message.body, now, false);
      createMessage(tenant, clinicId, {
        threadId,
        patientId: message.patientId,
        direction: 'outbound',
        status: 'sent',
        body: message.body,
        template: message.template,
        providerMessageId,
        appointmentId: message.appointmentId,
        sentAt: now,
        now,
      });
    } catch (error) {
      this.log('conversation mirror failed', clinicId, error);
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      // Skip rather than stack: a slow provider must not produce parallel ticks
      // racing each other for the same rows.
      if (this.running) return;
      this.running = true;
      void this.tick()
        .catch((error) => this.log('tick failed', null, error))
        .finally(() => {
          this.running = false;
        });
    }, this.intervalMs);
    // Unref'd so a worker process is not held open by a pending timer.
    this.timer.unref();
  }

  /** Stop the loop and wait for an in-flight tick, so no row is left claimed. */
  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    for (let waited = 0; waited < 5_000 && this.running; waited += 50) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  private log(message: string, clinicId: string | null, error: unknown): void {
    // The error text is truncated and never logged with context that could
    // include a provider's echo of the patient's message body.
    const detail = error instanceof Error ? error.message.slice(0, 200) : 'unknown';
    process.stdout.write(
      `[${this.id}] ${message}${clinicId ? ` (clinic ${clinicId})` : ''}: ${detail}\n`,
    );
  }
}
