/**
 * Create the first owner account on a REAL database.
 *
 *   node apps/api/scripts/create-owner.mjs <email> <password> [clinic-name]
 *
 * `npm run db:seed` deliberately refuses to run in production, and the public
 * join flow needs working SMTP for its verification code. A fresh production
 * database therefore has no way to gain its first login, which is what this
 * script is for. Run it once, from Render Shell, then forget it.
 *
 * All the real work lives in `src/services/bootstrap.ts` (same code path as
 * POST /system/bootstrap); this file is only argv parsing plus printing.
 * DATABASE_FILE is read from the environment, so on Render it automatically
 * targets /data/mediflow.db.
 */

import { createRequire } from 'node:module';

// The API compiles to CommonJS, so its dist modules are pulled in through a
// require hook rather than import. Same code paths as the running server.
const require = createRequire(import.meta.url);
const { openDatabase } = require('../dist/db/index.js');
const { bootstrapOwner, BootstrapError } = require('../dist/services/bootstrap.js');

async function main() {
  const [emailRaw, password, ...nameParts] = process.argv.slice(2);
  const email = (emailRaw ?? '').trim();
  const clinicName = nameParts.join(' ').trim() || undefined;

  if (!email || !password) {
    console.error('Usage: node apps/api/scripts/create-owner.mjs <email> <password> [clinic-name]');
    process.exit(2);
  }

  const databaseFile = process.env.DATABASE_FILE ?? './data/mediflow.db';
  console.log(`Database: ${databaseFile}`);
  const db = openDatabase({ file: databaseFile });

  try {
    const result = await bootstrapOwner(db, { email, password, clinicName });
    console.log('Created:');
    console.log(`  Clinic: ${result.clinicName} (${result.clinicId})`);
    console.log(`  Owner:  ${result.ownerEmail} (${result.ownerUserId})`);
    console.log('Sign in with the password you just passed. Clear the shell history afterwards.');
  } catch (error) {
    if (error instanceof BootstrapError) {
      console.error(`Refusing: ${error.message}`);
      process.exit(1);
    }
    throw error;
  } finally {
    db.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
