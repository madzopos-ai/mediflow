/**
 * SQLite backup CLI: online, timestamped, checksum-verified copies.
 *
 * Usage:
 *   npm run db:backup --workspace @mediflow/api
 *   npm run db:backup --workspace @mediflow/api -- --dir /backups --keep 14
 *
 * Why this exists: the API is the source of truth in self-hosted / local
 * deployments (better-sqlite3 file). A filesystem copy of a live SQLite file
 * can be corrupt; `Database.backup()` takes a transactional snapshot while
 * the server keeps running, so backups are always consistent.
 *
 * Each run writes `<dir>/mediflow-YYYYMMDD-HHMMSS.db` plus a `.sha256` sidecar
 * and prunes copies older than `--keep` days (default 7). Point a cron job or
 * systemd timer at it; exit code is non-zero on any failure so schedulers
 * alert. Firestore production projects use `npm run db:backup:firestore`
 * (gcloud export) instead - see tools/firestore-backup.sh.
 */

import { createHash } from 'node:crypto';
import { createReadStream, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

import { loadConfig } from '../config.js';
import { openDatabase } from './index.js';

function arg(name: string, fallback: string): string {
  const prefix = `--${name}=`;
  for (const raw of process.argv.slice(2)) {
    if (raw.startsWith(prefix)) return raw.slice(prefix.length);
  }
  return fallback;
}

function stamp(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function sha256File(path: string): Promise<string> {
  return new Promise((resolveHash, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk as Buffer));
    stream.on('end', () => resolveHash(hash.digest('hex')));
    stream.on('error', reject);
  });
}

async function main(): Promise<void> {
  const config = loadConfig();
  if (config.databaseFile === ':memory:') {
    throw new Error('Refusing to back up :memory:. Set DATABASE_FILE to the live file.');
  }
  const dir = resolve(arg('dir', process.env.BACKUP_DIR ?? './backups'));
  const keepDays = Number(arg('keep', process.env.BACKUP_KEEP_DAYS ?? '7'));
  mkdirSync(dir, { recursive: true });

  const db = openDatabase({ file: config.databaseFile });
  try {
    // Stage to tmp on the same volume, then snapshot into it: the live file
    // is never locked longer than the backup call itself.
    const staged = join(tmpdir(), `mediflow-backup-${Date.now()}.db`);
    await db.backup(staged);
    const dest = join(dir, `mediflow-${stamp(new Date())}.db`);
    const { renameSync, writeFileSync } = await import('node:fs');
    renameSync(staged, dest);
    const checksum = await sha256File(dest);
    writeFileSync(`${dest}.sha256`, `${checksum}  ${basename(dest)}\n`);
    process.stdout.write(`backup ok: ${dest}\nsha256: ${checksum}\n`);

    // Prune by age; a corrupt backup is worse than no backup, so only files
    // matching our own naming scheme are ever deleted.
    if (Number.isFinite(keepDays) && keepDays >= 0) {
      const cutoff = Date.now() - keepDays * 24 * 60 * 60 * 1000;
      for (const entry of readdirSync(dir)) {
        if (!/^mediflow-\d{8}-\d{6}\.db(\.sha256)?$/.test(entry)) continue;
        const full = join(dir, entry);
        if (statSync(full).mtimeMs < cutoff) {
          rmSync(full);
          process.stdout.write(`pruned: ${entry}\n`);
        }
      }
    }
  } finally {
    db.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`backup failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
