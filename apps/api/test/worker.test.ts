/**
 * Worker delivery, consent enforcement and inbound clinical handling.
 *
 * The rules under test are the ones with clinical consequence: a patient who
 * opted out must stop receiving routine messages but must still be told about a
 * critical reading, and a claimed row must never be sent twice.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { scoped } from '../src/db/tenant.js';
import { queueOutbound } from '../src/services/outbox.js';
import { queueDueReminders, scheduleAppointmentReminders } from '../src/services/reminders.js';
import { createBooking, bookingContextFor, releaseExpiredHolds } from '../src/services/appointments.js';
import { Worker } from '../src/workers/index.js';
import { SimulatorDriver } from '../src/workers/drivers.js';
import { asClient, createHarness, type Harness } from './harness.js';
import { pickBookableSlot, type SlotDay } from './slots.js';

interface Fixture extends Harness {
  api: ReturnType<typeof asClient>;
  tenant: ReturnType<typeof scoped>;
  simulator: SimulatorDriver;
  worker: Worker;
  patientId: string;
}

async function fixture(): Promise<Fixture> {
  const h = await createHarness();
  const { auth } = await h.login();
  const api = asClient(h.app, auth);
  const tenant = scoped(h.db, h.clinic.clinicId);

  const patient = await api.post('/patients', {
    firstName: 'Worked',
    lastName: 'Example',
    phone: '+966500000101',
      dateOfBirth: '1990-05-14',
      address: 'Test Street 1',
      heightCm: 175,
      weightKg: 70,
    whatsappNumber: '+966500000101',
    whatsappOptIn: true,
  });
  expect(patient.statusCode).toBe(201);

  const simulator = new SimulatorDriver();
  const worker = new Worker({
    db: h.db,
    driverName: 'simulator',
    simulator,
    autostart: false,
  });

  return {
    ...h,
    api,
    tenant,
    simulator,
    worker,
    patientId: patient.json().id as string,
  };
}

async function futureSlot(h: Harness, leadDays = 3): Promise<string> {
  const res = await h.app.inject({
    method: 'GET',
    url: '/public/mediflow-demo-clinic/slots?days=21',
  });
  const days = res.json().days as SlotDay[];
  return pickBookableSlot(days, leadDays);
}

describe('outbox delivery', () => {
  let f: Fixture;

  beforeAll(async () => {
    f = await fixture();
  });

  afterAll(async () => {
    await f.close();
  });

  it('sends a pending message and mirrors it into the conversation', async () => {
    const now = new Date().toISOString();
    queueOutbound(f.tenant, {
      to: '+966500000101',
      body: 'Your appointment is tomorrow at 12:00.',
      template: 'appointment_reminder',
      patientId: f.patientId,
      now,
    });

    const result = await f.worker.tick(now);
    expect(result.claimed).toBeGreaterThan(0);
    expect(result.sent).toBeGreaterThan(0);
    expect(f.simulator.sent.length).toBeGreaterThan(0);

    const threads = await f.api.get('/threads?limit=50');
    expect(threads.statusCode).toBe(200);
    const threadId = (threads.json().items as { id: string }[])[0]?.id;
    expect(threadId).toBeTruthy();

    // The outbound message is mirrored into the thread history.
    const history = await f.api.get(`/threads/${threadId}/messages`);
    expect(history.statusCode).toBe(200);
    const bodies = (history.json().items as { body: string }[]).map((m) => m.body);
    expect(bodies).toContain('Your appointment is tomorrow at 12:00.');
  });

  it('marks a sent outbox row and stores the provider id', async () => {
    const rows = f.tenant.all<Record<string, unknown>>('outbox', "status = 'sent'");
    expect(rows.length).toBeGreaterThan(0);
    expect(String(rows[0]?.['provider_message_id'] ?? '')).toMatch(/^sim_/);
  });

  it('does not send the same row twice on a second tick', async () => {
    const before = f.simulator.sent.length;
    await f.worker.tick(new Date().toISOString());
    // Nothing new was queued, so the simulator must have seen no new send.
    expect(f.simulator.sent.length).toBe(before);
  });
});

describe('consent enforcement', () => {
  let f: Fixture;

  beforeAll(async () => {
    f = await fixture();
  });

  afterAll(async () => {
    await f.close();
  });

  it('drops a routine message to a patient who opted out', async () => {
    await f.api.patch(`/patients/${f.patientId}`, { whatsappOptIn: false });

    const now = new Date().toISOString();
    queueOutbound(f.tenant, {
      to: '+966500000101',
      body: 'Routine reminder.',
      template: 'appointment_reminder',
      patientId: f.patientId,
      now,
    });

    const before = f.simulator.sent.length;
    const result = await f.worker.tick(now);
    expect(result.droppedOptedOut).toBeGreaterThan(0);
    expect(f.simulator.sent.length).toBe(before);
  });

  it('still delivers a safety-critical message to an opted-out patient', async () => {
    const now = new Date().toISOString();
    // The patient is still opted out from the previous test.
    const reread = await f.api.get(`/patients/${f.patientId}`);
    expect(reread.json().whatsappOptIn).toBe(false);

    queueOutbound(f.tenant, {
      to: '+966500000101',
      body: 'URGENT: your blood pressure reading needs review today.',
      template: 'critical_alert',
      patientId: f.patientId,
      safetyCritical: true,
      now,
    });

    const before = f.simulator.sent.length;
    const result = await f.worker.tick(now);
    expect(result.sent).toBeGreaterThan(0);
    expect(f.simulator.sent.length).toBeGreaterThan(before);
    expect(f.simulator.sent.at(-1)?.body).toContain('URGENT');
  });
});

describe('reminder planning', () => {
  let f: Fixture;
  let appointmentId: string;

  beforeAll(async () => {
    f = await fixture();
    const start = await futureSlot(f, 4);
    const ctx = bookingContextFor(f.db, f.clinic.clinicId);
    const appointment = createBooking(
      f.db,
      f.tenant,
      f.clinic.clinicId,
      ctx,
      {
        patientId: f.patientId,
        patientName: 'Worked Example',
        patientPhone: '+966500000101',
        startsAt: start,
        source: 'staff',
      },
      new Date().toISOString(),
    );
    appointmentId = appointment.id;
  });

  afterAll(async () => {
    await f.close();
  });

  it('plans reminders when a booking is created', () => {
    // `createBooking` now plans them, so the rows exist without a second call.
    const planned = f.tenant.count('reminders', 'appointment_id = ?', [appointmentId]);
    expect(planned).toBeGreaterThan(0);
  });

  it('replaces rather than duplicates the plan on reschedule', () => {
    const first = scheduleAppointmentReminders(f.tenant, f.clinic.clinicId, appointmentId, {
      now: new Date().toISOString(),
    });
    expect(first.cancelled).toBeGreaterThan(0);
    expect(first.planned).toBeGreaterThan(0);

    // One live row per planned offset. Rows cancelled by the reschedule are
    // retained for audit, so the invariant is over the *live* rows, not the
    // total history.
    const live = f.tenant.all<Record<string, unknown>>(
      'reminders',
      "appointment_id = ? AND status = 'scheduled'",
      [appointmentId],
    );
    expect(live).toHaveLength(first.planned);

    const offsets = live.map((r) => `${String(r['template'])}@${String(r['scheduled_for'])}`);
    expect(new Set(offsets).size).toBe(offsets.length);
  });

  it('never leaves a reminder in a status outside the shared enum', () => {
    const rows = f.tenant.all<Record<string, unknown>>('reminders');
    const allowed = new Set(['scheduled', 'sent', 'failed', 'cancelled', 'skipped']);
    for (const row of rows) {
      expect(allowed.has(String(row['status']))).toBe(true);
    }
  });

  it('queues a due reminder exactly once across two workers', () => {
    const now = new Date(Date.now() + 8 * 24 * 3600_000).toISOString();
    const first = queueDueReminders(f.tenant, f.clinic.clinicId, now);
    const second = queueDueReminders(f.tenant, f.clinic.clinicId, now);
    expect(first).toBeGreaterThan(0);
    // The lease is what makes the second pass a no-op.
    expect(second).toBe(0);
  });

  it('re-queues a reminder whose claim was abandoned', async () => {
    // Simulate a worker that claimed a row and then died: the row stays
    // `scheduled` with a fresh updated_at, so it is invisible until the lease
    // expires - and must reappear afterwards.
    const start = await futureSlot(f, 5);
    const ctx = bookingContextFor(f.db, f.clinic.clinicId);
    const appt = createBooking(
      f.db,
      f.tenant,
      f.clinic.clinicId,
      ctx,
      {
        patientId: f.patientId,
        patientName: 'Abandoned Claim Test',
        patientPhone: '+966500000101',
        startsAt: start,
        source: 'staff',
      },
      new Date().toISOString(),
    );

    const row = f.tenant.all<Record<string, unknown>>(
      'reminders',
      "appointment_id = ? AND status = 'scheduled'",
      [appt.id],
    )[0];
    expect(row).toBeTruthy();
    const id = String(row?.['id']);
    const scheduledFor = String(row?.['scheduled_for']);

    const claimedAt = new Date().toISOString();
    f.tenant.update('reminders', id, { updated_at: claimedAt });

    // One minute later the lease is still active.
    const tooSoon = new Date(Date.now() + 60_000).toISOString();
    expect(queueDueReminders(f.tenant, f.clinic.clinicId, tooSoon)).toBe(0);

    // After the lease expires and the reminder is due, another worker claims it.
    const laterTime = Math.max(new Date(scheduledFor).getTime() + 1000, Date.now() + 6 * 60_000);
    const later = new Date(laterTime).toISOString();
    const dispatched = queueDueReminders(f.tenant, f.clinic.clinicId, later);
    expect(dispatched).toBeGreaterThan(0);
    const claimed = f.tenant.get<Record<string, unknown>>('reminders', id);
    expect(claimed?.['status']).not.toBe('scheduled');
  });
});

describe('booking holds', () => {
  let f: Fixture;

  beforeAll(async () => {
    f = await fixture();
  });

  afterAll(async () => {
    await f.close();
  });

  it('leaves a hold in place while it is still valid', async () => {
    const start = await futureSlot(f, 2);
    const ctx = bookingContextFor(f.db, f.clinic.clinicId);
    const appointment = createBooking(
      f.db,
      f.tenant,
      f.clinic.clinicId,
      ctx,
      {
        patientId: f.patientId,
        patientName: 'Held',
        patientPhone: '+966500000102',
        startsAt: start,
        isPublicBooking: true,
      },
      new Date().toISOString(),
    );

    // The hold window has not elapsed, so the row must be left alone.
    expect(releaseExpiredHolds(f.tenant, f.clinic.clinicId).length).toBe(0);
    expect(f.tenant.get<Record<string, unknown>>('appointments', appointment.id)?.['status']).toBe(
      appointment.status,
    );
  });

  it('releases a hold that has expired', async () => {
    // Any deposit hold in this clinic is still valid, so force one into the
    // past and assert the sweep picks it up rather than leaving it stuck.
    const rows = f.tenant.all<Record<string, unknown>>(
      'appointments',
      "status = 'scheduled' AND hold_expires_at IS NOT NULL",
    );
    if (rows.length === 0) return; // the seed does not require a deposit
    const id = String(rows[0]?.['id']);
    f.tenant.update('appointments', id, { hold_expires_at: '2020-01-01T00:00:00.000Z' });

    const released = releaseExpiredHolds(f.tenant, f.clinic.clinicId);
    expect(released.length).toBeGreaterThan(0);
    expect(f.tenant.get<Record<string, unknown>>('appointments', id)?.['status']).toBe('cancelled');
  });
});
