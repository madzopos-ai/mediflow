/**
 * Booking, scheduling and consent.
 *
 * These cover the invariants that a double-booking, a leaked slot or a
 * consent violation would violate: transactional overlap rejection, the
 * minimum-notice window, and the consent audit trail.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { asClient, createHarness, type Harness } from './harness.js';
import { flattenSlots, pickBookableSlot, type SlotDay } from './slots.js';

interface HarnessWithAuth extends Harness {
  api: ReturnType<typeof asClient>;
}

const SLUG = 'mediflow-demo-clinic';

async function harnessWithAuth(): Promise<HarnessWithAuth> {
  const h = await createHarness();
  const { auth } = await h.login();
  return { ...h, api: asClient(h.app, auth) };
}

async function publicSlots(h: Harness, days = 21): Promise<SlotDay[]> {
  const res = await h.app.inject({ method: 'GET', url: `/public/${SLUG}/slots?days=${days}` });
  expect(res.statusCode).toBe(200);
  return res.json().days as SlotDay[];
}

describe('public booking', () => {
  let h: HarnessWithAuth;

  beforeAll(async () => {
    h = await harnessWithAuth();
  });

  afterAll(async () => {
    await h.close();
  });

  it('does not disclose the route table to an unauthenticated probe', async () => {
    const res = await h.app.inject({ method: 'GET', url: `/public/${h.clinic.clinicId}` });
    // No such route (the slug is not the clinic id), and auth fails closed
    // before routing, so the answer must not confirm the path exists.
    expect([401, 404]).toContain(res.statusCode);
  });

  it('returns 404 for an unknown slug rather than an empty clinic', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/public/no-such-clinic-slug/clinic' });
    expect(res.statusCode).toBe(404);
  });

  it('offers slots whose local time matches the clinic timezone', async () => {
    const res = await h.app.inject({ method: 'GET', url: `/public/${SLUG}/slots?days=14` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.timeZone).toBe('Asia/Riyadh');

    const days = body.days as SlotDay[];
    expect(days.length).toBeGreaterThan(0);
    const day = days[0];
    const first = day?.slots[0];
    expect(first, 'the seeded schedule should offer at least one slot').toBeTruthy();
    if (!day || !first) return;
    // Every slot's local label must equal the same instant rendered in the
    // clinic timezone (Asia/Riyadh). A server in another timezone that formats
    // in local time would shift every appointment by hours.
    const expectedLocal = (iso: string): string =>
      new Intl.DateTimeFormat('en-GB', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
        timeZone: 'Asia/Riyadh',
      }).format(new Date(iso));
    for (const d of days) {
      for (const slot of d.slots) {
        expect(slot.localStart).toBe(expectedLocal(slot.startsAt));
        expect(slot.localEnd).toBe(expectedLocal(slot.endsAt));
      }
    }
  });

  it('rejects a booking outside working hours', async () => {
    const days = await publicSlots(h);
    const day = days[0];
    expect(day).toBeTruthy();
    if (!day) return;
    // 03:00 local on a working day is never bookable.
    const res = await h.app.inject({
      method: 'POST',
      url: `/public/${SLUG}/book`,
      payload: {
        name: 'Night Owl',
        phone: '+966500000010',
        startsAt: `${day.dateKey}T00:00:00.000Z`,
      },
    });
    expect(res.statusCode).toBe(409);
  });

  it('rejects a slot inside the minimum notice period', async () => {
    const clinic = await h.app.inject({ method: 'GET', url: `/public/${SLUG}/clinic` });
    const minNoticeHours = (clinic.json() as { booking?: { minNoticeHours?: number } }).booking?.minNoticeHours ?? 2;
    const days = await publicSlots(h, 1);
    const today = days.find((d) => d.slots.length > 0);
    const start = today?.slots[0]?.startsAt;
    if (!start) return; // nothing bookable today; the rule cannot be exercised
    if (Date.parse(start) - Date.now() > minNoticeHours * 3600_000) {
      // The first slot is further out than the notice window (e.g. just after
      // midnight clinic time) - legitimately bookable, so the rule that
      // rejects inside-notice slots cannot be exercised on it.
      return;
    }
    const res = await h.app.inject({
      method: 'POST',
      url: `/public/${SLUG}/book`,
      payload: { name: 'Impatient', phone: '+966500000015', startsAt: start },
    });
    expect(res.statusCode).toBe(409);
  });

  it('books a real slot and returns a confirmation token', async () => {
    const days = await publicSlots(h);
    const start = pickBookableSlot(days);
    const res = await h.app.inject({
      method: 'POST',
      url: `/public/${SLUG}/book`,
      payload: { name: 'Ayesha Khan', phone: '+966500000011', startsAt: start },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.confirmationToken).toBeTruthy();
    expect(body.status).toBeTruthy();
  });

  it('refuses a second booking that overlaps the first', async () => {
    const days = await publicSlots(h);
    const all = flattenSlots(days);
    // A slot far enough out that the earlier tests did not take it.
    const start = all[all.length - 2];
    expect(start).toBeTruthy();

    const first = await h.app.inject({
      method: 'POST',
      url: `/public/${SLUG}/book`,
      payload: { name: 'First Booker', phone: '+966500000012', startsAt: start },
    });
    expect(first.statusCode).toBe(201);

    const second = await h.app.inject({
      method: 'POST',
      url: `/public/${SLUG}/book`,
      payload: { name: 'Second Booker', phone: '+966500000013', startsAt: start },
    });
    expect(second.statusCode).toBe(409);
  });

  it('lets the patient cancel with the token and refuses a wrong one', async () => {
    const days = await publicSlots(h);
    const all = flattenSlots(days);
    const start = all[all.length - 1];

    const booked = await h.app.inject({
      method: 'POST',
      url: `/public/${SLUG}/book`,
      payload: { name: 'Canceller', phone: '+966500000014', startsAt: start },
    });
    expect(booked.statusCode).toBe(201);
    const token = booked.json().confirmationToken as string;

    const wrong = await h.app.inject({ method: 'POST', url: '/public/booking/not-a-real-token/cancel' });
    expect(wrong.statusCode).toBe(404);

    const looked = await h.app.inject({ method: 'GET', url: `/public/booking/${token}` });
    expect(looked.statusCode).toBe(200);
    expect(looked.json().startsAt).toBe(booked.json().startsAt);

    const cancelled = await h.app.inject({ method: 'POST', url: `/public/booking/${token}/cancel` });
    expect(cancelled.statusCode).toBe(200);

    // A second cancellation must not succeed.
    const again = await h.app.inject({ method: 'POST', url: `/public/booking/${token}/cancel` });
    expect(again.statusCode).toBe(409);
  });

  it('frees the slot again after a cancellation', async () => {
    const days = await publicSlots(h);
    const all = flattenSlots(days);
    const start = all[all.length - 1];
    expect(start).toBeTruthy();

    const booked = await h.app.inject({
      method: 'POST',
      url: `/public/${SLUG}/book`,
      payload: { name: 'Round Trip', phone: '+966500000016', startsAt: start },
    });
    expect(booked.statusCode).toBe(201);
    await h.app.inject({ method: 'POST', url: `/public/booking/${booked.json().confirmationToken}/cancel` });

    const rebooked = await h.app.inject({
      method: 'POST',
      url: `/public/${SLUG}/book`,
      payload: { name: 'Second Time', phone: '+966500000017', startsAt: start },
    });
    expect(rebooked.statusCode).toBe(201);
  });
});

describe('appointments', () => {
  let h: HarnessWithAuth;

  beforeAll(async () => {
    h = await harnessWithAuth();
  });

  afterAll(async () => {
    await h.close();
  });

  it('lists appointments for the clinic', async () => {
    const res = await h.api.get('/appointments?limit=10');
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json().items)).toBe(true);
  });

  it('resolves a path id instead of rejecting it as a bad query', async () => {
    const res = await h.api.get('/appointments/apt_does_not_exist');
    // A 404 proves the path parameter was read; a 400 would mean the route
    // parsed the wrong half of the request.
    expect(res.statusCode).toBe(404);
  });

  it('rejects an overlapping staff booking', async () => {
    const days = await publicSlots(h);
    const start = pickBookableSlot(days, 3);

    const first = await h.api.post('/appointments', {
      patientName: 'Walk In',
      patientPhone: '+966500000030',
      startsAt: start,
    });
    expect(first.statusCode).toBe(201);

    const second = await h.api.post('/appointments', {
      patientName: 'Walk In Two',
      patientPhone: '+966500000031',
      startsAt: start,
    });
    expect(second.statusCode).toBe(409);
  });

  it('links a staff booking to a registered patient', async () => {
    const days = await publicSlots(h);
    const start = pickBookableSlot(days, 6);

    const patient = await h.api.post('/patients', {
      firstName: 'Linked',
      lastName: 'Patient',
      phone: '+966500000032',
      dateOfBirth: '1985-03-02',
      address: 'Test Street 2',
      heightCm: 170,
      weightKg: 68,
    });
    expect(patient.statusCode).toBe(201);
    const patientId = patient.json().id as string;

    const booked = await h.api.post('/appointments', {
      patientId,
      patientName: 'Linked Patient',
      patientPhone: '+966500000032',
      startsAt: start,
    });
    expect(booked.statusCode).toBe(201);
    expect(booked.json().patientId).toBe(patientId);

    const unknown = await h.api.post('/appointments', {
      patientId: 'pat_does_not_exist',
      patientName: 'Ghost',
      patientPhone: '+966500000033',
      startsAt: start,
    });
    // A booking must never silently detach from a mistyped patient id.
    expect(unknown.statusCode).toBe(404);
  });

  it('cancels an appointment and frees the slot', async () => {
    const days = await publicSlots(h);
    const start = pickBookableSlot(days, 5);

    const created = await h.api.post('/appointments', {
      patientName: 'Cancellable',
      patientPhone: '+966500000032',
      startsAt: start,
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().id as string;

    const cancelled = await h.api.post(`/appointments/${id}/cancel`, { reason: 'Patient unwell' });
    expect(cancelled.statusCode).toBe(200);

    const reread = await h.api.get(`/appointments/${id}`);
    expect(reread.statusCode).toBe(200);
    expect(['cancelled', 'canceled']).toContain(reread.json().status);
  });
});

describe('consent', () => {
  let h: HarnessWithAuth;

  beforeAll(async () => {
    h = await harnessWithAuth();
  });

  afterAll(async () => {
    await h.close();
  });

  it('stamps consent on grant and clears it on withdrawal', async () => {
    const created = await h.api.post('/patients', {
      firstName: 'Consent',
      lastName: 'Tester',
      phone: '+966500000020',
      dateOfBirth: '1990-05-14',
      address: 'Test Street 1',
      heightCm: 175,
      weightKg: 70,
      whatsappOptIn: false,
    });
    expect(created.statusCode).toBe(201);

    const enabled = await h.api.patch(`/patients/${created.json().id}`, { whatsappOptIn: true });
    expect(enabled.statusCode).toBe(200);
    expect(enabled.json().whatsappOptIn).toBe(true);
    expect(enabled.json().whatsappOptInAt).toBeTruthy();

    const withdrawn = await h.api.patch(`/patients/${created.json().id}`, { whatsappOptIn: false });
    expect(withdrawn.statusCode).toBe(200);
    // Withdrawing consent must clear the timestamp, not leave a stale one.
    expect(withdrawn.json().whatsappOptIn).toBe(false);
    expect(withdrawn.json().whatsappOptInAt).toBeNull();
  });

  it('leaves consent untouched when the patch omits it', async () => {
    const created = await h.api.post('/patients', {
      firstName: 'Untouched',
      lastName: 'Consent',
      phone: '+966500000021',
      dateOfBirth: '1990-05-14',
      address: 'Test Street 1',
      heightCm: 175,
      weightKg: 70,
      whatsappOptIn: true,
    });
    const before = created.json().whatsappOptInAt as string;
    expect(before).toBeTruthy();

    const patched = await h.api.patch(`/patients/${created.json().id}`, { city: 'Riyadh' });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().whatsappOptIn).toBe(true);
    expect(patched.json().whatsappOptInAt).toBe(before);
  });

  it('lists the outbox for the clinic', async () => {
    const res = await h.api.get('/outbox?limit=10');
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json().items)).toBe(true);
    expect(res.json().counts).toBeTruthy();
  });
});
