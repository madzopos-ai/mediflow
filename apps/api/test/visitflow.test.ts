/**
 * Visit flow: requested tests and prescriptions.
 *
 * Pins the diabetes-visit story: order panels at visit 1, link the result
 * document at visit 2 (and never another patient's), and close with a
 * structured prescription the patient app can render as a schedule.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { asClient, createHarness, type Harness } from './harness.js';
import { pickBookableSlot } from './slots.js';
import type { SlotDay } from './slots.js';

const SLUG = 'mediflow-demo-clinic';

describe('visit flow', () => {
  let h: Harness;
  let api: ReturnType<typeof asClient>;
  let patientId: string;

  beforeAll(async () => {
    h = await createHarness();
    api = asClient(h.app, (await h.login()).auth);
    const created = await api.post('/patients', {
      firstName: 'Flow',
      lastName: 'Patient',
      phone: '+966500000200',
      dateOfBirth: '1975-08-20',
      address: 'Flow Street 1',
      heightCm: 168,
      weightKg: 82,
    });
    expect(created.statusCode).toBe(201);
    patientId = created.json().id as string;
  });

  afterAll(async () => {
    await h.close();
  });

  it('orders a test and completes it with the result document', async () => {
    const ordered = await api.post('/requested-tests', {
      patientId,
      name: 'HbA1c',
      notes: 'First visit labs.',
    });
    expect(ordered.statusCode).toBe(201);
    const order = ordered.json() as { id: string; status: string };
    expect(order.status).toBe('requested');

    const pending = await api.get(`/requested-tests?patientId=${patientId}&status=requested`);
    expect(pending.statusCode).toBe(200);
    expect((pending.json() as { items: unknown[] }).items.length).toBe(1);

    const doc = await api.post('/documents/upload', {
      patientId,
      kind: 'lab_report',
      title: 'HbA1c result',
      fileName: 'hba1c.pdf',
      mimeType: 'application/pdf',
      fileBase64: Buffer.from('%PDF result', 'utf8').toString('base64'),
    });
    expect(doc.statusCode).toBe(201);
    const documentId = (doc.json() as { id: string }).id;

    const done = await api.patch(`/requested-tests/${order.id}`, { status: 'done', documentId });
    expect(done.statusCode).toBe(200);
    expect((done.json() as { status: string }).status).toBe('done');
  });

  it('refuses to complete an order with another patient\'s document', async () => {
    const other = await api.post('/patients', {
      firstName: 'Other',
      lastName: 'Patient',
      phone: '+966500000201',
      dateOfBirth: '1980-01-01',
      address: 'Other Street 1',
      heightCm: 170,
      weightKg: 70,
    });
    const otherId = (other.json() as { id: string }).id;
    const otherDoc = await api.post('/documents/upload', {
      patientId: otherId,
      kind: 'lab_report',
      fileName: 'other.pdf',
      mimeType: 'application/pdf',
      fileBase64: Buffer.from('%PDF other', 'utf8').toString('base64'),
    });
    const otherDocId = (otherDoc.json() as { id: string }).id;

    const ordered = await api.post('/requested-tests', { patientId, name: 'CBC' });
    const orderId = (ordered.json() as { id: string }).id;
    const done = await api.patch(`/requested-tests/${orderId}`, { status: 'done', documentId: otherDocId });
    expect(done.statusCode).toBe(400);
  });

  it('writes a structured prescription the patient app can schedule', async () => {
    const created = await api.post('/prescriptions', {
      patientId,
      items: [
        { drug: 'Metformin', dose: '500mg', frequency: 'twice daily', durationDays: 30 },
        { drug: 'Atorvastatin', dose: '20mg', frequency: 'once nightly', durationDays: 30 },
      ],
      diet: ['Low sugar, whole grains'],
      exercise: ['Walk 30 minutes daily'],
      notes: 'Review in one month.',
    });
    expect(created.statusCode).toBe(201);
    const rx = created.json() as {
      items: { drug: string }[];
      diet: string[];
      exercise: string[];
      status: string;
    };
    expect(rx.items.map((i) => i.drug)).toEqual(['Metformin', 'Atorvastatin']);
    expect(rx.diet).toEqual(['Low sugar, whole grains']);
    expect(rx.status).toBe('active');

    const listed = await api.get(`/prescriptions?patientId=${patientId}&status=active`);
    expect(listed.statusCode).toBe(200);
    expect((listed.json() as { items: unknown[] }).items.length).toBeGreaterThan(0);
  });

  it('snapshots the chart labs onto each prescription', async () => {
    // Self-contained: records its own vitals rather than depending on order.
    await api.post('/vitals', {
      patientId,
      readings: [
        { kind: 'hba1c', value: 9.2 },
        { kind: 'creatinine', value: 2.1 },
      ],
    });
    const created = await api.post('/prescriptions', {
      patientId,
      items: [{ drug: 'Metformin', dose: '1000mg', frequency: 'twice daily' }],
    });
    expect(created.statusCode).toBe(201);
    const rx = created.json() as { labs: Record<string, number> };
    // The learner reads these back to say "your usual at HbA1c 9".
    expect(rx.labs['hba1c']).toBe(9.2);
    expect(rx.labs['creatinine']).toBe(2.1);
  });

  it('requires the chart fields on staff patient creation', async () => {
    const res = await api.post('/patients', {
      firstName: 'Missing',
      lastName: 'Fields',
      phone: '+966500000202',
    });
    expect(res.statusCode).toBe(400);
    const detail = (res.json() as { error: { detail: { path: string }[] } }).error.detail;
    expect(detail.map((d) => d.path)).toContain('dateOfBirth');
  });

  it('stores the age at creation', async () => {
    const res = await api.get(`/patients/${patientId}`);
    expect(res.statusCode).toBe(200);
    expect((res.json() as { ageYears: number }).ageYears).toBeGreaterThan(40);
  });

  it('feeds the chart labs into decision support', async () => {
    const posted = await api.post('/vitals', {
      patientId,
      readings: [
        { kind: 'creatinine', value: 2.1 },
        { kind: 'hba1c', value: 9.2 },
      ],
    });
    expect(posted.statusCode).toBe(201);

    const res = await api.post(`/records/${patientId}/decision-support`, {
      diagnosis: 'Type 2 diabetes with kidney involvement',
      candidateDrugIds: ['metformin'],
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      labsUsed: { kind: string; value: number }[];
      labGuided: { drug: string; dose: string; frequency: string; reasons: string[]; contraindicated: boolean }[];
      result: { dosingAdjustments: unknown[] };
    };
    // The prediction stood on these values - the UI shows its basis.
    const kinds = body.labsUsed.map((l) => l.kind);
    expect(kinds).toContain('creatinine');
    expect(kinds).toContain('hba1c');
    expect(body.labsUsed.find((l) => l.kind === 'creatinine')?.value).toBe(2.1);
    // Impaired kidneys must surface as dosing adjustments, not silence.
    expect(body.result.dosingAdjustments.length).toBeGreaterThan(0);

    // Doses name the drug, the amount, and the values behind both.
    const metformin = body.labGuided.find((g) => g.drug === 'Metformin');
    expect(metformin?.dose).toBe('1000mg');
    expect(metformin?.reasons.join(' ')).toContain('9.2');
  });

  it('lets the patient app book through the same availability rules', async () => {
    const slots = await h.app.inject({ method: 'GET', url: `/public/${SLUG}/slots?days=21` });
    const days = slots.json().days as SlotDay[];
    const start = pickBookableSlot(days, 7);

    const code = await api.post(`/patients/${patientId}/access-code`, {});
    expect(code.statusCode).toBe(200);
    const pin = (code.json() as { code: string }).code;

    const login = await h.app.inject({
      method: 'POST',
      url: '/auth/patient',
      payload: { phone: '+966500000200', code: pin },
    });
    expect(login.statusCode).toBe(200);
    const token = (login.json() as { token: string }).token;
    const pat = asClient(h.app, `Bearer ${token}`);

    const me = await pat.get('/patient/me');
    expect(me.statusCode).toBe(200);

    const booked = await pat.post('/patient/me/appointments', { startsAt: start });
    expect(booked.statusCode).toBe(201);
    expect((booked.json() as { patientId: string }).patientId).toBe(patientId);

    const upcoming = await pat.get('/patient/me/appointments');
    expect((upcoming.json() as { items: unknown[] }).items.length).toBeGreaterThan(0);

    const scripts = await pat.get('/patient/me/prescriptions');
    expect(scripts.statusCode).toBe(200);

    const wrong = await h.app.inject({
      method: 'POST',
      url: '/auth/patient',
      payload: { phone: '+966500000200', code: '000000' },
    });
    expect(wrong.statusCode).toBe(401);
  });
});
