/**
 * Migration runner behaviour.
 *
 * A migration that only works on an empty database is a latent data-loss bug, so
 * these tests insert rows, add the new migration, and assert the rows survive.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDatabase, migrate, type Db } from '../src/db/index.js';
import { MIGRATIONS } from '../src/db/migrations.js';

const dirs: string[] = [];

function freshDb(): { db: Db; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'mediflow-mig-'));
  dirs.push(dir);
  const file = join(dir, 'm.db');
  return { db: openDatabase({ file }), file };
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

describe('migrations', () => {
  it('applies every migration when the database is opened', () => {
    // `openDatabase` migrates before returning, so the assertion is on the
    // recorded set rather than on a second call's return value.
    const { db } = freshDb();
    const rows = db.prepare('SELECT id, name FROM _migrations ORDER BY id').all() as {
      id: number;
      name: string;
    }[];
    expect(rows.map((r) => r.id)).toEqual(MIGRATIONS.map((m) => m.id));
    expect(rows.every((r) => r.name.length > 0)).toBe(true);
    db.close();
  });

  it('is idempotent: a second run applies nothing', () => {
    const { db } = freshDb();
    migrate(db);
    expect(migrate(db)).toBe(0);
    db.close();
  });

  it('keeps existing rows when a later migration rebuilds a table', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mediflow-mig-'));
    dirs.push(dir);
    const file = join(dir, 'm.db');

    // Bring the database up to the state before the walk-in migration.
    const before = MIGRATIONS.filter((m) => m.id < 7);
    const first = openDatabase({ file, migrations: before });
    const clinic = 'clc_test';
    first
      .prepare(
        `INSERT INTO clinics (id, name, name_ar, slug, timezone, country, currency, created_at, updated_at)
         VALUES (?, 'C', 'C', 'c', 'UTC', 'SA', 'SAR', '2026-01-01', '2026-01-01')`,
      )
      .run(clinic);
    first
      .prepare(
        `INSERT INTO appointments
           (id, clinic_id, patient_id, starts_at, ends_at, timezone, status,
            confirmation_token, patient_name, patient_phone, created_at, updated_at)
         VALUES ('apt_1', ?, 'pat_1', '2026-01-01T09:00:00.000Z', '2026-01-01T09:20:00.000Z',
                 'UTC', 'booked', 'tok_1', 'A B', '+966500000001', '2026-01-01', '2026-01-01')`,
      )
      .run(clinic);
    first.close();

    // Now open with the full list: migration 7 rebuilds appointments.
    const second = openDatabase({ file });
    const kept = second.prepare('SELECT * FROM appointments WHERE id = ?').get('apt_1') as Record<
      string,
      unknown
    >;
    expect(kept).toBeTruthy();
    expect(kept['patient_id']).toBe('pat_1');
    expect(kept['confirmation_token']).toBe('tok_1');
    expect(kept['patient_name']).toBe('A B');

    // And a walk-in with no patient is now storable.
    second
      .prepare(
        `INSERT INTO appointments
           (id, clinic_id, patient_id, starts_at, ends_at, timezone, status,
            confirmation_token, patient_name, patient_phone, created_at, updated_at)
         VALUES ('apt_2', ?, NULL, '2026-01-02T09:00:00.000Z', '2026-01-02T09:20:00.000Z',
                 'UTC', 'booked', 'tok_2', 'Walk In', '+966500000002', '2026-01-02', '2026-01-02')`,
      )
      .run(clinic);
    const walkIn = second.prepare('SELECT patient_id FROM appointments WHERE id = ?').get('apt_2') as {
      patient_id: string | null;
    };
    expect(walkIn.patient_id).toBeNull();
    second.close();
  });

  it('adds the safety_critical column to outbox', () => {
    const { db } = freshDb();
    const columns = db.prepare('PRAGMA table_info(outbox)').all() as { name: string }[];
    expect(columns.map((c) => c.name)).toContain('safety_critical');
    db.close();
  });
});
