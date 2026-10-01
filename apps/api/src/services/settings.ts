/**
 * Clinic settings and schedule readers.
 *
 * These live in the service layer rather than in `routes/clinic.ts` because
 * services need them too: booking validation, the outbox worker, and the
 * public booking endpoints all read the same policy. A service importing from
 * a route module is a layering inversion, so the shared readers sit here and
 * the route re-exports them for its own handlers.
 *
 * Every read merges the stored value over the current defaults, so a clinic
 * created before a settings field existed still receives a sane value.
 */

import type { ClinicSchedule, ClinicSettings } from '@mediflow/shared';

import { defaultSchedule, defaultSettings } from '../db/defaults.js';
import { parseJson } from '../db/mappers.js';
import type { Db } from '../db/index.js';

export function readSchedule(db: Db, clinicId: string): ClinicSchedule {
  const row = db
    .prepare('SELECT json FROM clinic_schedules WHERE clinic_id = ?')
    .get(clinicId) as { json: string } | undefined;
  if (!row) return defaultSchedule(clinicId);
  return parseJson<ClinicSchedule>(row.json, defaultSchedule(clinicId));
}

export function readSettings(db: Db, clinicId: string): ClinicSettings {
  const row = db
    .prepare('SELECT json FROM clinic_settings WHERE clinic_id = ?')
    .get(clinicId) as { json: string } | undefined;
  if (!row) return defaultSettings();

  // Merge section by section so a newly added settings key still appears.
  const stored = parseJson<Partial<ClinicSettings>>(row.json, {});
  const base = defaultSettings();
  return {
    ...base,
    ...stored,
    features: { ...base.features, ...(stored.features ?? {}) },
    reminders: { ...base.reminders, ...(stored.reminders ?? {}) },
    followUps: { ...base.followUps, ...(stored.followUps ?? {}) },
    booking: { ...base.booking, ...(stored.booking ?? {}) },
    whatsapp: { ...base.whatsapp, ...(stored.whatsapp ?? {}) },
    ai: { ...base.ai, ...(stored.ai ?? {}) },
    finance: { ...base.finance, ...(stored.finance ?? {}) },
    notifications: { ...base.notifications, ...(stored.notifications ?? {}) },
  };
}

/** The clinic's IANA timezone, used for every local-time computation. */
export function clinicTimezone(db: Db, clinicId: string): string {
  const row = db.prepare('SELECT timezone FROM clinics WHERE id = ?').get(clinicId) as
    | { timezone: string }
    | undefined;
  return row?.timezone ?? 'UTC';
}
