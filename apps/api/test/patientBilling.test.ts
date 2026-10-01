/**
 * Patient billing transparency (P1): the patient app sees its own invoices,
 * cleared vs still-owed balances, and payment history - and nothing else's.
 *
 * Fences under test: the endpoint filters by the session patient id, a staff
 * JWT is rejected (patient endpoints only), and all money stays in integer
 * minor units.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { asClient, createHarness, type Harness } from './harness.js';

describe('patient billing', () => {
  let h: Harness;
  let api: ReturnType<typeof asClient>;
  let patientId: string;
  let patientPhone = '+966500000310';

  beforeAll(async () => {
    h = await createHarness();
    api = asClient(h.app, (await h.login()).auth);
    const created = await api.post('/patients', {
      firstName: 'Billing',
      lastName: 'Patient',
      phone: patientPhone,
      dateOfBirth: '1990-01-01',
      address: 'Billing Street 1',
      heightCm: 170,
      weightKg: 70,
    });
    expect(created.statusCode).toBe(201);
    patientId = created.json().id as string;
  });

  afterAll(async () => {
    await h.close();
  });

  async function patientClient(): Promise<ReturnType<typeof asClient>> {
    const code = await api.post(`/patients/${patientId}/access-code`, {});
    expect(code.statusCode).toBe(200);
    const pin = (code.json() as { code: string }).code;
    const login = await h.app.inject({
      method: 'POST',
      url: '/auth/patient',
      payload: { phone: patientPhone, code: pin },
    });
    expect(login.statusCode).toBe(200);
    return asClient(h.app, `Bearer ${(login.json() as { token: string }).token}`);
  }

  it('shows an empty ledger before any invoice', async () => {
    const pat = await patientClient();
    const res = await pat.get('/patient/me/invoices');
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      summary: { billedMinor: number; paidMinor: number; outstandingMinor: number };
      invoices: unknown[];
      payments: unknown[];
    };
    expect(body.summary.billedMinor).toBe(0);
    expect(body.summary.outstandingMinor).toBe(0);
    expect(body.invoices).toEqual([]);
    expect(body.payments).toEqual([]);
  });

  it('shows cleared vs owed after a partial payment', async () => {
    await api.patch(`/patients/${patientId}`, { insurerId: null });
    const invoice = await api.post('/invoices', {
      patientId,
      items: [{ description: 'consultation', unitPriceMinor: 2000, quantity: 1 }],
      taxPercent: 0,
    });
    expect(invoice.statusCode).toBe(201);

    const paid = await api.post('/payments', {
      patientId,
      invoiceId: (invoice.json() as { id: string }).id,
      amountMinor: 800,
      method: 'whish',
    });
    expect(paid.statusCode).toBe(201);

    const pat = await patientClient();
    const res = await pat.get('/patient/me/invoices');
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      summary: { billedMinor: number; paidMinor: number; outstandingMinor: number; currency: string };
      invoices: { status: string; patientShareMinor: number; paidMinor: number }[];
      payments: { amountMinor: number; method: string }[];
    };
    // Integer minor units end to end: $20 billed, $8 paid, $12 owed.
    expect(body.summary.billedMinor).toBe(2000);
    expect(body.summary.paidMinor).toBe(800);
    expect(body.summary.outstandingMinor).toBe(1200);
    expect(body.invoices).toHaveLength(1);
    expect(body.invoices[0]?.status).toBe('partial');
    expect(body.payments).toHaveLength(1);
    expect(body.payments[0]?.method).toBe('whish');
  });

  it('rejects staff sessions on the patient endpoint', async () => {
    const res = await api.get('/patient/me/invoices');
    expect(res.statusCode).toBe(403);
  });
});
