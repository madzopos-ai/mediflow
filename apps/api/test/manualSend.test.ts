/**
 * Manual click-to-send: the doctor sends from the WhatsApp app (wa.me link)
 * and the press is logged. Pins: pending -> sent with a manual provider id,
 * thread message mirrored to sent, idempotent repeat, 404 on unknown id.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { asClient, createHarness, type Harness } from './harness.js';

describe('manualsend', () => {
  let h: Harness;
  let api: ReturnType<typeof asClient>;
  let patientId: string;
  let outboxId: string;

  beforeAll(async () => {
    h = await createHarness();
    api = asClient(h.app, (await h.login()).auth);
    const created = await api.post('/patients', {
      firstName: 'Manual',
      lastName: 'Sender',
      phone: '+966500000320',
      dateOfBirth: '1990-01-01',
      address: 'Manual Street 1',
      heightCm: 170,
      weightKg: 70,
    });
    expect(created.statusCode).toBe(201);
    patientId = created.json().id as string;
    const optIn = await api.post(`/patients/${patientId}/opt-in`, {});
    expect([200, 201, 204].includes(optIn.statusCode)).toBe(true);
  });

  afterAll(async () => {
    await h.close();
  });

  it('queues a message for the pending list', async () => {
    const sent = await api.post('/messages', { patientId, body: 'Your appointment is tomorrow at 12:00.' });
    expect(sent.statusCode).toBe(201);
    const pending = await api.get('/outbox?status=pending');
    expect(pending.statusCode).toBe(200);
    const items = (pending.json() as { items: { id: string }[] }).items;
    expect(items.length).toBeGreaterThan(0);
    outboxId = items[0]?.id as string;
  });

  it('logs the manual press and mirrors the thread', async () => {
    const res = await api.post(`/outbox/${outboxId}/manual-send`, {});
    expect(res.statusCode).toBe(200);
    const row = res.json() as { status: string; providerMessageId: string };
    expect(row.status).toBe('sent');
    expect(row.providerMessageId).toBe('manual:wa.me');

    const threads = await api.get('/threads?limit=50');
    const threadId = (threads.json() as { items: { id: string }[] }).items[0]?.id as string;
    const history = await api.get(`/threads/${threadId}/messages`);
    const bodies = (history.json() as { items: { body: string; status: string }[] }).items;
    const mine = bodies.find((m) => m.body === 'Your appointment is tomorrow at 12:00.');
    expect(mine?.status).toBe('sent');
  });

  it('is idempotent on repeat presses', async () => {
    const again = await api.post(`/outbox/${outboxId}/manual-send`, {});
    expect(again.statusCode).toBe(200);
    expect((again.json() as { status: string }).status).toBe('sent');
  });

  it('returns 404 for an unknown row', async () => {
    const missing = await api.post('/outbox/does-not-exist/manual-send', {});
    expect(missing.statusCode).toBe(404);
  });
});
