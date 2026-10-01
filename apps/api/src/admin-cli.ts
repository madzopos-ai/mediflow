/**
 * Reseller console: approve the practices that joined.
 *
 * Join signups land inactive on purpose - nobody enters before the
 * administrator accepts them. These commands list the queue and flip it:
 *
 *   npm run admin:pending
 *   npm run admin:approve -- user@clinic.test
 *
 * Approving activates the user AND their clinic together; one without the
 * other is either a login into nothing or a bookable ghost clinic.
 */

import { loadConfig } from './config.js';
import { openDatabase } from './db/index.js';

function usage(): never {
  process.stdout.write('Usage:\n  npm run admin:pending\n  npm run admin:approve -- <email>\n');
  process.exit(1);
}

async function main(): Promise<void> {
  const [command, arg] = process.argv.slice(2);
  const config = loadConfig();
  const db = openDatabase({ file: config.databaseFile });
  try {
    if (command === 'pending') {
      const rows = db
        .prepare(
          `SELECT u.email, u.full_name, u.role, u.created_at, c.name AS clinic
             FROM users u JOIN clinics c ON c.id = u.clinic_id
            WHERE u.is_active = 0 OR c.is_active = 0
            ORDER BY u.created_at ASC`,
        )
        .all() as { email: string; full_name: string; role: string; created_at: string; clinic: string }[];
      if (rows.length === 0) {
        process.stdout.write('No pending practices.\n');
        return;
      }
      for (const row of rows) {
        process.stdout.write(`${row.email} | ${row.full_name} | ${row.role} | ${row.clinic} | ${row.created_at}\n`);
      }
      return;
    }

    if (command === 'approve' && arg) {
      const email = arg.toLowerCase().trim();
      const user = db.prepare('SELECT id, clinic_id FROM users WHERE email = ?').get(email) as
        | { id: string; clinic_id: string }
        | undefined;
      if (!user) {
        process.stderr.write(`No such user: ${email}\n`);
        process.exit(1);
      }
      const now = new Date().toISOString();
      const apply = db.transaction(() => {
        db.prepare('UPDATE users SET is_active = 1, updated_at = ? WHERE id = ?').run(now, user.id);
        db.prepare('UPDATE clinics SET is_active = 1, updated_at = ? WHERE id = ?').run(now, user.clinic_id);
      });
      apply();
      process.stdout.write(`Approved ${email}: user and clinic are active.\n`);
      return;
    }

    usage();
  } finally {
    db.close();
  }
}

void main();
