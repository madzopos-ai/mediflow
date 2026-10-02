/**
 * Adds one doctor (clinic + owner account + gateway entry) on this server.
 *
 * Run by Setup-MediFlow.bat after the build, or any time later to onboard
 * another clinic - it loops until you say no:
 *   node tools/local-server/add-doctor.cjs
 *
 * Environment (set by the Setup bat, with real paths):
 *   DATABASE_FILE   SQLite file to create the account in
 *   GW_CONFIG       gateway-config.json path to upsert into
 *   GW_PROJECT_ID   default Firebase project for new clinics
 *   GW_SESSION_BASE base dir for per-clinic WhatsApp sessions
 *   GW_KEY_PATH     service-account key path (may be empty; gateway waits)
 *
 * Everything is asked interactively with validation, so there is nothing to
 * pre-fill and nothing that can be typoed silently: bad emails, short
 * passwords and malformed numbers are re-asked on the spot.
 */

const readline = require('node:readline');

// Plain .cjs already has require; dist modules load straight through it.
const path = require('node:path');
const { openDatabase } = require('../../apps/api/dist/db/index.js');
const { bootstrapOwner, createClinicOwner, BootstrapError } = require('../../apps/api/dist/services/bootstrap.js');
const { upsertClinic } = require('./add-clinic.cjs');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

// Batch mode: when stdin is redirected (file/pipe), readline on Windows
// closes after the first question, so answers are consumed from a plain
// line array instead. Interactive consoles keep the prompting readline.
let batchLines = null;
if (!process.stdin.isTTY) {
  try {
    batchLines = require('node:fs').readFileSync(0, 'utf8').split(/\r?\n/);
  } catch {
    batchLines = [];
  }
}

function ask(question) {
  if (batchLines) {
    const answer = (batchLines.length ? batchLines.shift() : '').trim();
    console.log(question + answer);
    return Promise.resolve(answer);
  }
  return new Promise((resolve) => rl.question(question, (answer) => resolve(answer.trim())));
}

function validEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

async function addOne(db, env) {
  let email = '';
  for (;;) {
    email = (await ask('  Doctor email: ')).toLowerCase();
    if (validEmail(email)) break;
    console.log('  That email looks wrong, try again (example: doctor@clinic.com).');
  }
  let password = '';
  for (;;) {
    password = await ask('  Password (at least 10 characters): ');
    if (password.length >= 10) break;
    console.log('  Too short, try again.');
  }
  const clinicName = (await ask('  Clinic name: ')) || 'MediFlow Clinic';
  let phone = '';
  for (;;) {
    phone = (await ask('  Clinic WhatsApp number, digits with country code (example: 96170123456): ')).replace(/[^0-9]/g, '');
    if (/^[0-9]{7,15}$/.test(phone)) break;
    console.log('  Digits only with country code, try again.');
  }

  let result;
  try {
    result = await bootstrapOwner(db, { email, password, clinicName });
  } catch (error) {
    if (error instanceof BootstrapError && error.code === 'already_bootstrapped') {
      // Second, third, ... doctor: same writes, minus the empty-database gate.
      try {
        result = await createClinicOwner(db, { email, password, clinicName });
      } catch (inner) {
        if (inner instanceof BootstrapError) {
          console.log(`  Skipped: ${inner.message}`);
          return false;
        }
        throw inner;
      }
    } else if (error instanceof BootstrapError) {
      console.log(`  Skipped: ${error.message}`);
      return false;
    } else {
      throw error;
    }
  }

  const n = upsertClinic(env.config, {
    clinicId: result.clinicId,
    projectId: env.project,
    phone,
    sessionDir: path.join(env.sessionBase, result.clinicId),
    serviceAccountPath: env.keyPath,
  });

  console.log('');
  console.log(`  DONE: ${result.ownerEmail} owns "${result.clinicName}" (${result.clinicId}).`);
  console.log(`  Gateway config now serves ${n} clinic(s).`);
  console.log('  Next: open the WhatsApp page in the app and scan the QR with the clinic phone.');
  return true;
}

async function main() {
  const env = {
    database: process.env.DATABASE_FILE ?? './data/mediflow.db',
    config: process.env.GW_CONFIG ?? './gateway-config.json',
    project: process.env.GW_PROJECT_ID ?? 'mediflow-baalbeck',
    sessionBase: process.env.GW_SESSION_BASE ?? './gateway-sessions',
    keyPath: process.env.GW_KEY_PATH ?? '',
  };
  console.log(`Database: ${env.database}`);
  const db = openDatabase({ file: env.database });
  try {
    for (;;) {
      console.log('');
      await addOne(db, env);
      const more = (await ask('  Add another doctor? (yes/no): ')).toLowerCase();
      if (!['yes', 'y', 'نعم', 'اي', 'اه'].includes(more)) break;
    }
  } finally {
    db.close();
    rl.close();
  }
  console.log('Finished. Restart the gateway task so it picks up new clinics (or reboot).');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
