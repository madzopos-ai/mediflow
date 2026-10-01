/**
 * `npm run db:seed`
 *
 * Creates a development clinic, an owner account, and sample patients.
 * Refuses to run in production, so a stray command cannot create a login in a
 * real database.
 */

import { loadConfig } from '../config.js';
import { openDatabase } from './index.js';
import { seed } from './seed.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const db = openDatabase({ file: config.databaseFile, verbose: false });
  try {
    const result = await seed(db, {
      clinicName: process.env.SEED_CLINIC_NAME ?? 'MediFlow Demo Clinic',
      clinicNameAr: process.env.SEED_CLINIC_NAME_AR ?? 'عيادة ميدي فلو التجريبية',
      ownerEmail: process.env.SEED_OWNER_EMAIL ?? 'owner@mediflow.test',
      ownerPassword: process.env.SEED_OWNER_PASSWORD,
      timezone: process.env.SEED_TIMEZONE ?? 'Asia/Riyadh',
      currency: process.env.SEED_CURRENCY ?? 'SAR',
      locale: 'ar',
      isProduction: config.isProduction,
    });

    process.stdout.write(
      [
        result.created ? 'Created a new clinic.' : 'Clinic already existed; nothing was changed.',
        `Clinic id: ${result.clinicId}`,
        `Owner:     ${result.ownerEmail} (${result.ownerUserId})`,
        'Password:  unchanged (pass SEED_OWNER_PASSWORD to set one)',
        '',
      ].join('\n'),
    );
  } finally {
    db.close();
  }
}

void main();
