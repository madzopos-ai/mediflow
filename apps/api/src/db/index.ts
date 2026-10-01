/**
 * Database connection and migration runner.
 *
 * SQLite is opened with WAL so a long analytics read does not block the
 * reminder worker writing, and foreign keys are enforced explicitly because
 * SQLite defaults them OFF per connection - which would silently allow
 * appointments pointing at a deleted clinic.
 */

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { MIGRATIONS, type Migration } from './migrations.js';

export type Db = Database.Database;

export interface OpenOptions {
  /** File path, or ':memory:' for tests. */
  file: string;
  verbose?: boolean;
  /**
   * Migration set to apply instead of the full list.
   *
   * Only a migration test needs this: to prove a table rebuild preserves rows,
   * the database must first be brought to the *previous* schema version.
   */
  migrations?: readonly Migration[];
}

export function openDatabase(options: OpenOptions): Db {
  if (options.file !== ':memory:') {
    mkdirSync(dirname(resolve(options.file)), { recursive: true });
  }
  const db = new Database(options.file, options.verbose ? { verbose: console.log } : {});

  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  // Durability balanced against write throughput; clinical data should not be
  // lost to a power cut mid-transaction.
  db.pragma('synchronous = NORMAL');

  applyMigrations(db, options.migrations ?? MIGRATIONS);
  return db;
}

/** Apply a given migration set, recording what ran. Safe to call repeatedly. */
export function applyMigrations(db: Db, migrations: readonly Migration[]): number {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);

  const applied = new Set(
    db.prepare('SELECT id FROM _migrations').all().map((row) => (row as { id: number }).id),
  );

  let count = 0;
  for (const migration of migrations) {
    if (applied.has(migration.id)) continue;
    // Each migration is atomic: a failure leaves the database on the last good
    // version rather than half-upgraded.
    const run = db.transaction(() => {
      db.exec(migration.sql);
      db.prepare('INSERT INTO _migrations (id, name, applied_at) VALUES (?, ?, ?)').run(
        migration.id,
        migration.name,
        new Date().toISOString(),
      );
    });
    run();
    count += 1;
  }
  return count;
}

/** Apply any migrations not yet recorded. Safe to call on every boot. */
export function migrate(db: Db): number {
  return applyMigrations(db, MIGRATIONS);
}

/** Wipe every row while keeping the schema. Used by tests and `db:reset`. */
export function truncateAll(db: Db): void {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != '_migrations'")
    .all()
    .map((row) => (row as { name: string }).name);

  // `PRAGMA foreign_keys` is a no-op inside a transaction, so it has to be
  // toggled outside one. Without this, deleting parents before children fails
  // on the foreign keys and the reset leaves a half-empty database.
  db.pragma('foreign_keys = OFF');
  try {
    const wipe = db.transaction(() => {
      for (const table of tables) db.exec(`DELETE FROM "${table}"`);
    });
    wipe();
  } finally {
    db.pragma('foreign_keys = ON');
  }
}
