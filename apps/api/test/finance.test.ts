/**
 * Finance: insurers, dollar-amount invoices, and the pay-down flow.
 *
 * Pins the money behaviour the clinic relies on: an insurer carries one
 * coverage percent, an invoice tracks what is left (total - paid), and every
 * payment method the UI offers - including Whish - is accepted.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { asClient, createHarness, type Harness } from './harness.js';

describe('finance', () => {
  let h: Harness;
  let api: ReturnType<typeof asClient>;
  let patientId: string;
  let insurerId: string;

  beforeAll(async () => {
    h = await createHarness();
    api = asClient(h.app, (await h.login()).auth);
    const created = await api.post('/patients', {
      firstName: 'Money',
      lastName: 'Patient',
      phone: '+966500000300',
      dateOfBirth: '1990-01-01',
      address: 'Money Street 1',
      heightCm: 170,
      weightKg: 70,
    });
    expect(created.statusCode).toBe(201);
    patientId = created.json().id as string;
  });

  afterAll(async () => {
    await h.close();
  });

  it('manages contracted insurers with coverage and caps', async () => {
    const created = await api.post('/insurers', {
      name: 'MedGulf',
      nameAr: 'مدغلف',
      coveragePercent: 80,
      annualLimitMinor: 500000,
      perVisitLimitMinor: 20000,
      phone: '+9611000000',
      notes: 'Direct billing.',
    });
    expect(created.statusCode).toBe(201);
    const insurer = created.json() as { id: string; coveragePercent: number };
    expect(insurer.coveragePercent).toBe(80);
    insurerId = insurer.id;

    const patched = await api.patch(`/insurers/${insurerId}`, { coveragePercent: 85 });
    expect(patched.statusCode).toBe(200);
    expect((patched.json() as { coveragePercent: number }).coveragePercent).toBe(85);

    const listed = await api.get('/insurers');
    expect(listed.statusCode).toBe(200);
    expect(((listed.json() as { items: unknown[] }).items.length)).toBeGreaterThan(0);
  });

  it('links a patient to an insurer and rejects an unknown one', async () => {
    const linked = await api.patch(`/patients/${patientId}`, {
      insurerId,
      insurerPolicyNo: 'POL-123',
    });
    expect(linked.statusCode).toBe(200);
    expect((linked.json() as { insurerPolicyNo: string }).insurerPolicyNo).toBe('POL-123');

    const bad = await api.patch(`/patients/${patientId}`, { insurerId: 'ins_does_not_exist' });
    expect(bad.statusCode).toBe(404);
  });

  it('requires a policy number with an insurer link', async () => {
    const fresh = await api.post('/patients', {
      firstName: 'No',
      lastName: 'Policy',
      phone: '+966500000301',
      dateOfBirth: '1992-02-02',
      address: 'Policy Street 1',
      heightCm: 170,
      weightKg: 70,
      insurerId,
    });
    expect(fresh.statusCode).toBe(400);

    // Unlink, then relink without a policy number: still refused.
    await api.patch(`/patients/${patientId}`, { insurerId: null, insurerPolicyNo: null });
    const relink = await api.patch(`/patients/${patientId}`, { insurerId });
    expect(relink.statusCode).toBe(400);
    const ok = await api.patch(`/patients/${patientId}`, { insurerId, insurerPolicyNo: 'POL-123' });
    expect(ok.statusCode).toBe(200);
  });

  it('tracks what is left on an invoice across partial payments', async () => {
    // Uninsured for this scenario: the insurer tests link and unlink below.
    await api.patch(`/patients/${patientId}`, { insurerId: null });
    const invoice = await api.post('/invoices', {
      patientId,
      items: [{ description: 'consultation', unitPriceMinor: 2000, quantity: 1 }],
      taxPercent: 0,
    });
    expect(invoice.statusCode).toBe(201);
    const invoiceId = (invoice.json() as { id: string }).id;

    // $20 invoice, $8 by Whish: $12 left, status partial.
    const first = await api.post('/payments', {
      patientId,
      invoiceId,
      amountMinor: 800,
      method: 'whish',
    });
    expect(first.statusCode).toBe(201);

    const reread = await api.get(`/invoices/${invoiceId}`);
    const state = (reread.json() as { invoice: { total_minor: number; paid_minor: number; status: string } }).invoice;
    expect(state.total_minor).toBe(2000);
    expect(state.paid_minor).toBe(800);
    expect(state.status).toBe('partial');

    // The remaining $12 by card: paid in full.
    const second = await api.post('/payments', {
      patientId,
      invoiceId,
      amountMinor: 1200,
      method: 'card',
    });
    expect(second.statusCode).toBe(201);
    const done = (await api.get(`/invoices/${invoiceId}`)).json() as {
      invoice: { status: string; paid_minor: number };
    };
    expect(done.invoice.status).toBe('paid');
    expect(done.invoice.paid_minor).toBe(2000);

    const history = await api.get(`/payments?patientId=${patientId}`);
    expect(history.statusCode).toBe(200);
    expect(((history.json() as { items: unknown[] }).items.length)).toBeGreaterThanOrEqual(2);
  });

  it('splits an invoice with the patient insurer and settles the patient share', async () => {
    // Self-contained: link the 85% insurer regardless of test order.
    await api.patch(`/patients/${patientId}`, { insurerId });
    // $10 at 85% coverage: $8.50 insurer, $1.50 patient.
    const invoice = await api.post('/invoices', {
      patientId,
      items: [{ description: 'consultation', unitPriceMinor: 1000, quantity: 1 }],
      taxPercent: 0,
    });
    expect(invoice.statusCode).toBe(201);
    const created = invoice.json() as {
      id: string;
      total_minor: number;
      insurer_share_minor: number;
      patient_share_minor: number;
      status: string;
    };
    expect(created.total_minor).toBe(1000);
    expect(created.insurer_share_minor).toBe(850);
    expect(created.patient_share_minor).toBe(150);
    expect(created.status).toBe('pending');

    // The patient's $1.50 closes the invoice even though $8.50 is "unpaid".
    const paid = await api.post('/payments', {
      patientId,
      invoiceId: created.id,
      amountMinor: 150,
      method: 'cash',
    });
    expect(paid.statusCode).toBe(201);
    const done = (await api.get(`/invoices/${created.id}`)).json() as {
      invoice: { status: string; paid_minor: number };
    };
    expect(done.invoice.status).toBe('paid');
    expect(done.invoice.paid_minor).toBe(150);
  });

  it('respects the per-visit cap and ignores inactive insurers', async () => {
    const capped = await api.post('/insurers', {
      name: 'CappedCare',
      coveragePercent: 100,
      perVisitLimitMinor: 500,
    });
    const cappedId = (capped.json() as { id: string }).id;
    await api.patch(`/patients/${patientId}`, { insurerId: cappedId });

    // $10 at 100% but capped at $5: patient owes $5.
    const invoice = await api.post('/invoices', {
      patientId,
      items: [{ description: 'consultation', unitPriceMinor: 1000, quantity: 1 }],
      taxPercent: 0,
    });
    const created = invoice.json() as { insurer_share_minor: number; patient_share_minor: number };
    expect(created.insurer_share_minor).toBe(500);
    expect(created.patient_share_minor).toBe(500);

    // Deactivate: the next invoice is all patient again.
    await api.patch(`/insurers/${cappedId}`, { isActive: false });
    const plain = await api.post('/invoices', {
      patientId,
      items: [{ description: 'consultation', unitPriceMinor: 1000, quantity: 1 }],
      taxPercent: 0,
    });
    const plainBody = plain.json() as { insurer_share_minor: number; patient_share_minor: number };
    expect(plainBody.insurer_share_minor).toBe(0);
    expect(plainBody.patient_share_minor).toBe(1000);

    // Restore the main insurer for the other tests' patient.
    await api.patch(`/patients/${patientId}`, { insurerId });
  });

  it('filters invoices and payments by date', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const invoices = await api.get(`/invoices?from=${today}&to=${today}&limit=100`);
    expect(invoices.statusCode).toBe(200);
    expect(((invoices.json() as { items: unknown[] }).items.length)).toBeGreaterThan(0);

    const ancient = await api.get('/invoices?from=2000-01-01&to=2000-01-02&limit=100');
    expect(((ancient.json() as { items: unknown[] }).items.length)).toBe(0);

    const payments = await api.get(`/payments?from=${today}&to=${today}&limit=100`);
    expect(payments.statusCode).toBe(200);
  });

  it('tracks what an insurer owes and what was collected', async () => {
    await api.patch(`/patients/${patientId}`, { insurerId });

    // $20 at 85%: $17 insurer, $3 patient. Patient pays in full.
    const invoice = await api.post('/invoices', {
      patientId,
      items: [{ description: 'procedure', unitPriceMinor: 2000, quantity: 1 }],
      taxPercent: 0,
    });
    const created = invoice.json() as { id: string };
    await api.post('/payments', { patientId, invoiceId: created.id, amountMinor: 300, method: 'cash' });

    const statement = await api.get(`/insurers/${insurerId}/statement`);
    expect(statement.statusCode).toBe(200);
    const body = statement.json() as {
      billedMinor: number;
      collectedMinor: number;
      outstandingMinor: number;
      invoices: { patientName: string; policyNo: string | null; insurerShareMinor: number }[];
    };
    expect(body.billedMinor).toBeGreaterThanOrEqual(1700);
    const before = body.outstandingMinor;
    // Every audit line names who owes it and under which reference.
    const line = body.invoices.find((i) => i.insurerShareMinor === 1700);
    expect(line?.patientName).toBe('Money Patient');
    expect(line?.policyNo).toBe('POL-123');

    // Collect $10: the outstanding drops by exactly that.
    const collected = await api.post('/insurer-payments', {
      insurerId,
      amountMinor: 1000,
      reference: 'TRF-1',
    });
    expect(collected.statusCode).toBe(201);
    expect((collected.json() as { outstandingMinor: number }).outstandingMinor).toBe(before - 1000);

    // Over-collection is refused, not silently accepted.
    const tooMuch = await api.post('/insurer-payments', { insurerId, amountMinor: before });
    expect(tooMuch.statusCode).toBe(400);
  });
});
