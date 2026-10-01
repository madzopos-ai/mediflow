/**
 * Dashboard regression tests.
 *
 * `/dashboard/today` sorts open alerts with a CASE expression over quoted
 * severity literals. The ORDER BY guard once rejected the quotes, which turned
 * the whole dashboard into a 500 - the single most visible screen in the app.
 * These tests pin the behaviour with real alert rows present.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { asClient, createHarness, type Harness } from './harness.js';
import { scoped } from '../src/db/tenant.js';

describe('dashboard', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await createHarness();
    const tenant = scoped(h.db, h.clinic.clinicId);
    const now = new Date().toISOString();
    tenant.insert('clinical_alerts', {
      id: 'alrt_info_1',
      clinic_id: h.clinic.clinicId,
      kind: 'missed_reading',
      severity: 'info',
      status: 'open',
      title: 'Info alert',
      body: 'Less urgent.',
      created_at: now,
      updated_at: now,
    });
    tenant.insert('clinical_alerts', {
      id: 'alrt_critical_1',
      clinic_id: h.clinic.clinicId,
      kind: 'critical_reading',
      severity: 'critical',
      status: 'open',
      title: 'Critical alert',
      body: 'Most urgent.',
      created_at: now,
      updated_at: now,
    });
  });

  afterAll(async () => {
    await h.close();
  });

  it('serves today with critical alerts first', async () => {
    const api = asClient(h.app, (await h.login()).auth);
    const res = await api.get('/dashboard/today');
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      alerts: { open: number; items: { severity: string }[] };
    };
    expect(body.alerts.open).toBe(2);
    expect(body.alerts.items[0]?.severity).toBe('critical');
  });

  it('serves the alerts list with the same triage ordering', async () => {
    const api = asClient(h.app, (await h.login()).auth);
    const res = await api.get('/alerts?limit=10');
    expect(res.statusCode).toBe(200);
    const items = (res.json() as { items: { severity: string }[] }).items;
    expect(items[0]?.severity).toBe('critical');
  });
});
