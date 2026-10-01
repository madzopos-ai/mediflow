/**
 * HTTP server entry point.
 *
 * Migration runs before the socket is bound, so the process never accepts a
 * request against a schema it has not verified.
 */

import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { openDatabase } from './db/index.js';

async function main(): Promise<void> {
  const config = loadConfig();
  // `openDatabase` applies any pending migrations before returning, so the
  // socket is never bound against a schema that has not been verified.
  const db = openDatabase({ file: config.databaseFile });

  const app = await buildApp({ config, db });

  // The worker runs in-process by default for a single-container deployment.
  // A larger clinic deployment sets REMINDER_WORKER_ENABLED=false here and runs
  // `npm run worker` as its own process; the claim is safe either way.
  let worker: { start(): void; stop(): Promise<void> } | null = null;
  if (config.reminderWorkerEnabled) {
    const { Worker } = await import('./workers/index.js');
    worker = new Worker({
      db,
      driverName: config.whatsappProvider,
      intervalMs: config.workerIntervalMs,
      whatsapp:
        config.whatsappProvider === 'cloud' && config.whatsappCloudToken && config.whatsappCloudPhoneNumberId
          ? { token: config.whatsappCloudToken, phoneNumberId: config.whatsappCloudPhoneNumberId }
          : undefined,
    });
    worker.start();
  }

  const shutdown = (signal: string): void => {
    app.log.info(`${signal} received, shutting down.`);
    void (async () => {
      // Stop accepting connections first, then drain the worker, then close the
      // database - in that order, so a tick in flight can still write.
      await app.close();
      if (worker) await worker.stop();
      db.close();
      process.exit(0);
    })();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  try {
    await app.listen({ host: config.host, port: config.port });
  } catch (error) {
    app.log.error(error);
    if (worker) await worker.stop();
    db.close();
    process.exit(1);
  }
}

void main();
