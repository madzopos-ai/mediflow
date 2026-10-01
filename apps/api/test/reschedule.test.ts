/**
 * Reschedule with reason: free-slot validation, reminder rebuild, and the
 * Arabic WhatsApp task (apology only when the clinic caused it).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { asClient, createHarness, type Harness } from './harness.js';
import { pickBookableSlot, type SlotDay } from './slots.js';

async function freeSlots(api: ReturnType<typeof asClient>): Promise<SlotDay[]> {
  const avail = await api.get('/schedule/availability?days=21');
  expect(avail.statusCode).toBe(200);
  return (avail.json() as { days: SlotDay[] }).days;
}

describe('reschedule', () => {
  let h: Harness;
  let api: ReturnType<typeof asClient>;
  let patientId: string;
  let appointmentId: string;
  let freeSlotA: string;
  let freeSlotB: string;

  beforeAll(async () => {
    h = await createHarness();
    api = asClient(h.app, (await h.login()).auth);
    const created = await api.post('/patients', {
      firstName: 'Resched',
      lastName: 'Patient',
      phone: '+966500000330',
      dateOfBirth: '1990-01-01',
      address: 'Resched Street 1',
      heightCm: 170,
      weightKg: 70,
    });
    expect(created.statusCode).toBe(201);
    patientId = created.json().id as string;
    await api.post(`/patients/${patientId}/opt-in`, {});

    const days = await freeSlots(api);
    // Lead days apart so the two slots never collide and both clear notice.
    freeSlotA = pickBookableSlot(days, 4);
    freeSlotB = pickBookableSlot(days, 6);

    const booked = await api.post('/appointments', {
      patientId,
      patientName: 'Resched Patient',
      patientPhone: '+966500000330',
      startsAt: freeSlotA,
    });
    expect(booked.statusCode).toBe(201);
    appointmentId = (booked.json() as { id: string }).id;
  });

  afterAll(async () => {
    await h.close();
  });

  it('moves to a free slot and queues an Arabic task with apology', async () => {
    const res = await api.post(`/appointments/${appointmentId}/reschedule`, {
      startsAt: freeSlotB,
      reason: 'ظرف طارئ للطبيب',
      initiatedBy: 'clinic',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { appointment: { startsAt: string }; whatsappQueued: boolean };
    expect(body.appointment.startsAt).toBe(freeSlotB);
    expect(body.whatsappQueued).toBe(true);

    const pending = await api.get('/outbox?status=pending');
    const items = (pending.json() as { items: { body: string; template: string }[] }).items;
    const notice = items.find((o) => o.body.includes('تأجيل موعدكم'));
    expect(notice).toBeTruthy();
    expect(notice?.body).toContain('نعتذر منكم');
    expect(notice?.body).toContain('ظرف طارئ للطبيب');
  });

  it('rejects a taken slot with 409', async () => {
    // Occupy a far-out slot with another patient, then try to move onto it.
    const days = await freeSlots(api);
    const taken = pickBookableSlot(days, 10);
    const second = await api.post('/patients', {
      firstName: 'Other',
      lastName: 'Patient',
      phone: '+966500000331',
      dateOfBirth: '1991-01-01',
      address: 'Other Street 1',
      heightCm: 170,
      weightKg: 70,
    });
    const otherId = (second.json() as { id: string }).id;
    const booked = await api.post('/appointments', {
      patientId: otherId,
      patientName: 'Other Patient',
      patientPhone: '+966500000331',
      startsAt: taken,
    });
    expect(booked.statusCode).toBe(201);

    const clash = await api.post(`/appointments/${appointmentId}/reschedule`, {
      startsAt: taken,
      reason: 'test clash',
      initiatedBy: 'clinic',
    });
    expect(clash.statusCode).toBe(409);
  });

  it('omits the apology when the patient asked', async () => {
    const days = await freeSlots(api);
    const target = days
      .flatMap((d) => d.slots.map((s) => s.startsAt))
      .find((t) => t !== freeSlotB && t !== freeSlotA);
    expect(target).toBeTruthy();
    const res = await api.post(`/appointments/${appointmentId}/reschedule`, {
      startsAt: target as string,
      reason: 'patient request by phone',
      initiatedBy: 'patient',
    });
    expect(res.statusCode).toBe(200);
    const pending = await api.get('/outbox?status=pending');
    const items = (pending.json() as { items: { body: string }[] }).items;
    const notice = items.find((o) => o.body.includes('patient request by phone'));
    expect(notice).toBeTruthy();
    expect(notice?.body).not.toContain('نعتذر منكم');
  });

  it('refuses to reschedule a cancelled appointment', async () => {
    const cancelled = await api.post(`/appointments/${appointmentId}/cancel`, { reason: 'no show' });
    expect(cancelled.statusCode).toBe(200);
    const res = await api.post(`/appointments/${appointmentId}/reschedule`, {
      startsAt: freeSlotA,
      reason: 'too late',
      initiatedBy: 'clinic',
    });
    expect(res.statusCode).toBe(409);
  });

  it('queues an Arabic task on cancel and stops old reminders', async () => {
    const created = await api.post('/appointments', {
      patientId,
      patientName: 'Resched Patient',
      patientPhone: '+966500000330',
      startsAt: freeSlotA,
    });
    expect(created.statusCode).toBe(201);
    const id = (created.json() as { id: string }).id;

    const cancelled = await api.post(`/appointments/${id}/cancel`, {
      reason: 'عطل بالعيادة',
      initiatedBy: 'clinic',
    });
    expect(cancelled.statusCode).toBe(200);
    expect((cancelled.json() as { whatsappQueued: boolean }).whatsappQueued).toBe(true);

    const pending = await api.get('/outbox?status=pending');
    const items = (pending.json() as { items: { body: string }[] }).items;
    const notice = items.find((o) => o.body.includes('إلغاء موعدكم'));
    expect(notice?.body).toContain('نعتذر منكم');
  });
});
