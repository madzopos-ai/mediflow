/**
 * `npm run db:reset`
 *
 * Deletes every row while keeping the schema. Development and test databases
 * only, so it refuses to run when NODE_ENV is production unless `--force` is
 * passed - and even then it prints what it is about to delete first.
 */

import { loadConfig } from '../config.js';
import { openDatabase, truncateAll } from './index.js';

function main(): void {
  const config = loadConfig();
  const force = process.argv.includes('--force');

  if (config.isProduction && !force) {
    process.stderr.write(
      'Refusing to reset a production database. Re-run with --force if you really mean it.\n',
    );
    process.exit(1);
  }

  const db = openDatabase({ file: config.databaseFile, verbose: false });
  try {
    const counts = db
      .prepare(
        `SELECT 'patients' AS t, COUNT(*) AS n FROM patients
         UNION ALL SELECT 'appointments', COUNT(*) FROM appointments
         UNION ALL SELECT 'payments', COUNT(*) FROM payments
         UNION ALL SELECT 'messages', COUNT(*) FROM messages`,
      )
      .all() as { t: string; n: number }[];

    process.stdout.write(
      `About to delete all data from ${config.databaseFile}:\n` +
        counts.map((c) => `  ${c.t}: ${c.n}`).join('\n') +
        '\n',
    );

    truncateAll(db);
    process.stdout.write('Database reset. Schema is unchanged.\n');
  } finally {
    db.close();
  }
}

main();
