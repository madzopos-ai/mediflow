/**
 * Standalone worker process.
 *
 * Run this instead of the in-process worker when reminders and outbound
 * messages should keep flowing independently of HTTP request latency:
 *
 *   npm run worker
 */

import { loadConfig } from './config.js';
import { openDatabase } from './db/index.js';
import { Worker } from './workers/index.js';

function main(): void {
  const config = loadConfig();
  const db = openDatabase({ file: config.databaseFile });

  const worker = new Worker({
    db,
    driverName: config.whatsappProvider,
    intervalMs: config.workerIntervalMs,
    whatsapp:
      config.whatsappProvider === 'cloud' && config.whatsappCloudToken && config.whatsappCloudPhoneNumberId
        ? { token: config.whatsappCloudToken, phoneNumberId: config.whatsappCloudPhoneNumberId }
        : undefined,
  });

  worker.start();
  process.stdout.write(`[${worker.id}] worker started (driver=${config.whatsappProvider})\n`);

  const shutdown = (): void => {
    process.stdout.write(`[${worker.id}] shutting down.\n`);
    void worker.stop().then(() => {
      db.close();
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
