/**
 * `npm run db:migrate`
 *
 * Applies pending migrations and prints what it did. Read-only in the sense that
 * it never touches data: each migration is forward-only and atomic.
 */

import { loadConfig } from '../config.js';
import { migrate, openDatabase } from './index.js';

function main(): void {
  const config = loadConfig();
  const db = openDatabase({ file: config.databaseFile, verbose: false });
  try {
    const applied = migrate(db);
    const total = (
      db.prepare('SELECT COUNT(*) AS n FROM _migrations').get() as { n: number }
    ).n;
    process.stdout.write(
      applied === 0
        ? `Database is up to date (${total} migrations applied).\n`
        : `Applied ${applied} migration(s); ${total} total.\n`,
    );
  } finally {
    db.close();
  }
}

main();
