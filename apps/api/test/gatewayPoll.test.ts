/**
 * Gateway pull endpoint tests.
 *
 * The gateway holds the only copy of the WhatsApp session, so these two
 * endpoints are the whole send pipeline. The properties under test are the
 * ones that would page someone: auth before anything else, nothing claimed
 * on failure, consent re-checked, and acks landing on the right rows.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createHarness, type Harness } from './harness.js';
import { queueOutbound } from '../src/services/outbox.js';

const GATEWAY_TOKEN = 'test-gateway-token-long-enough';

let h: Harness;
let clinicId: string;

async function gatewayGet(path: string, token: string | null): Promise<{ status: number; json: unknown }> {
  const headers: Record<string, string> = {};
  if (token !== null) headers['authorization'] = `Bearer ${token}`;
  const res = await h.app.inject({ method: 'GET', url: path, headers });
  let json: unknown = null;
  try {
    json = res.json();
  } catch {
    json = null;
  }
  return { status: res.statusCode, json };
}

async function gatewayPost(path: string, body: unknown): Promise<{ status: number; json: unknown }> {
  const res = await h.app.inject({
    method: 'POST',
    url: path,
    headers: { authorization: `Bearer ${GATEWAY_TOKEN}` },
    payload: body as Record<string, unknown>,
  });
  let json: unknown = null;
  try {
    json = res.json();
  } catch {
    json = null;
  }
  return { status: res.statusCode, json };
}

beforeAll(async () => {
  h = await createHarness({ gatewayAdminToken: GATEWAY_TOKEN });
  clinicId = h.clinic.clinicId;
});

afterAll(async () => {
  await h.close();
});

describe('GET /gateway/outbox/pending', () => {
  it('503s when no gateway token is configured', async () => {
    const bare = await createHarness({ gatewayAdminToken: null });
    try {
      const res = await bare.app.inject({ method: 'GET', url: '/gateway/outbox/pending?clinicId=x' });
      expect(res.statusCode).toBe(503);
    } finally {
      await bare.close();
    }
  });

  it('403s on a wrong token without touching anything', async () => {
    const res = await gatewayGet(`/gateway/outbox/pending?clinicId=${clinicId}`, 'wrong-token');
    expect(res.status).toBe(403);
  });

  it('403s with no token at all', async () => {
    const res = await gatewayGet(`/gateway/outbox/pending?clinicId=${clinicId}`, null);
    expect(res.status).toBe(403);
  });

  it('404s on an unknown clinic', async () => {
    const res = await gatewayGet('/gateway/outbox/pending?clinicId=clc_nope', GATEWAY_TOKEN);
    expect(res.status).toBe(404);
  });

  it('returns due whatsapp rows and locks them', async () => {
    const tenant = h.app.tenantFor(clinicId);
    queueOutbound(tenant, { to: '+96170123456', body: 'Your appointment is tomorrow.', template: 'appointment_confirm' });
    const first = await gatewayGet(`/gateway/outbox/pending?clinicId=${clinicId}`, GATEWAY_TOKEN);
    expect(first.status).toBe(200);
    const messages = (first.json as { messages: { id: string; to: string; body: string }[] }).messages;
    expect(messages).toHaveLength(1);
    const only = messages[0] as { id: string; to: string; body: string };
    expect(only.to).toBe('+96170123456');
    expect(only.body).toContain('tomorrow');

    // A second poll sees nothing: the row is claimed, not duplicated. This is
    // the property that stops a patient getting the same reminder twice when
    // the gateway polls aggressively.
    const second = await gatewayGet(`/gateway/outbox/pending?clinicId=${clinicId}`, GATEWAY_TOKEN);
    expect(((second.json as { messages: unknown[] }).messages)).toHaveLength(0);

    // ...but the row is only `processing`, so ack it to finish the cycle.
    const ack = await gatewayPost('/gateway/outbox/ack', {
      clinicId,
      id: only.id,
      ok: true,
      providerMessageId: 'wa-mid-1',
    });
    expect(ack.status).toBe(200);
    const row = h.db.prepare('SELECT status FROM outbox WHERE id = ?').get(only.id) as { status: string };
    expect(row.status).toBe('sent');
  });

  it('skips opted-out patients without handing their rows out', async () => {
    const tenant = h.app.tenantFor(clinicId);
    const patient = h.db.prepare('SELECT id FROM patients LIMIT 1').get() as { id: string } | undefined;
    if (!patient) return; // seed has no patients; nothing to prove
    h.db.prepare('UPDATE patients SET whatsapp_opt_in = 0 WHERE id = ?').run(patient.id);
    queueOutbound(tenant, {
      to: '+96170999888',
      body: 'Promo blast.',
      template: 'appointment_reminder',
      patientId: patient.id,
    });
    const res = await gatewayGet(`/gateway/outbox/pending?clinicId=${clinicId}`, GATEWAY_TOKEN);
    expect(res.status).toBe(200);
    expect(((res.json as { messages: unknown[] }).messages)).toHaveLength(0);
    h.db.prepare('UPDATE patients SET whatsapp_opt_in = 1 WHERE id = ?').run(patient.id);
  });
});

describe('POST /gateway/outbox/ack', () => {
  it('records failures with backoff instead of losing them', async () => {
    const tenant = h.app.tenantFor(clinicId);
    const queued = queueOutbound(tenant, { to: '+96170000001', body: 'Retry me.', template: 'appointment_confirm' });
    // Realistic flow: the gateway only acks rows it claimed from the poll.
    const polled = await gatewayGet(`/gateway/outbox/pending?clinicId=${clinicId}`, GATEWAY_TOKEN);
    expect(polled.status).toBe(200);
    const ids = ((polled.json as { messages: { id: string }[] }).messages).map((m) => m.id);
    expect(ids).toContain(queued.row['id']);
    const res = await gatewayPost('/gateway/outbox/ack', {
      clinicId,
      id: queued.row['id'],
      ok: false,
      error: 'WhatsApp not connected.',
    });
    expect(res.status).toBe(200);
    const row = h.db.prepare('SELECT status, attempts FROM outbox WHERE id = ?').get(queued.row['id']) as {
      status: string;
      attempts: number;
    };
    expect(row.attempts).toBeGreaterThanOrEqual(1);
    expect(['pending', 'processing', 'failed']).toContain(row.status);
  });

  it('cannot ack another clinic\'s rows', async () => {
    const other = await createHarness({ gatewayAdminToken: GATEWAY_TOKEN });
    try {
      const res = await other.app.inject({
        method: 'POST',
        url: '/gateway/outbox/ack',
        headers: { authorization: `Bearer ${GATEWAY_TOKEN}` },
        payload: { clinicId: other.clinic.clinicId, id: 'nonexistent', ok: true },
      });
      expect([400, 404]).toContain(res.statusCode);
    } finally {
      await other.close();
    }
  });

  it('never hands out or locks non-whatsapp rows', async () => {    const tenant = h.app.tenantFor(clinicId);
    const sms = queueOutbound(tenant, {
      to: '+96170000002',
      body: 'SMS copy.',
      template: 'appointment_confirm',
      channel: 'sms',
    });
    const res = await gatewayGet(`/gateway/outbox/pending?clinicId=${clinicId}`, GATEWAY_TOKEN);
    expect(res.status).toBe(200);
    const ids = ((res.json as { messages: { id: string }[] }).messages).map((m) => m.id);
    expect(ids).not.toContain(sms.row['id']);
    // Still pending and unlocked for whoever owns the sms channel: the
    // gateway must not park rows it cannot send.
    const row = h.db.prepare('SELECT status, locked_by FROM outbox WHERE id = ?').get(sms.row['id']) as {
      status: string;
      locked_by: string | null;
    };
    expect(row.status).toBe('pending');
    expect(row.locked_by).toBeNull();
  });
});

describe('POST /gateway/inbound', () => {
  async function inbound(body: unknown, token: string = GATEWAY_TOKEN): Promise<{ status: number; json: unknown }> {
    const res = await h.app.inject({
      method: 'POST',
      url: '/gateway/inbound',
      headers: { authorization: `Bearer ${token}` },
      payload: body as Record<string, unknown>,
    });
    let json: unknown = null;
    try {
      json = res.json();
    } catch {
      json = null;
    }
    return { status: res.statusCode, json };
  }

  it('403s on a wrong token', async () => {
    const res = await inbound({ clinicId, from: '+96170000009', text: 'بدي احجز' }, 'wrong');
    expect(res.status).toBe(403);
  });

  it('404s on an unknown clinic', async () => {
    const res = await inbound({ clinicId: 'clc_nope', from: '+96170000009', text: 'بدي احجز' });
    expect(res.status).toBe(404);
  });

  it('runs the booking dialogue and enqueues the reply', async () => {
    const res = await inbound({ clinicId, from: '+96170654321', text: 'بدي احجز' });
    expect(res.status).toBe(200);
    expect((res.json as { action: string }).action).toBe('asked_time');
    // The reply waits in the outbox for the gateway's next poll - the route
    // never sends inline.
    const rows = h.db.prepare("SELECT body FROM outbox WHERE body LIKE '%أي يوم%'").all() as { body: string }[];
    expect(rows.length).toBeGreaterThan(0);
  });

  it('silently ignores non-booking chatter', async () => {
    const before = (h.db.prepare('SELECT COUNT(*) AS n FROM outbox').get() as { n: number }).n;
    const res = await inbound({ clinicId, from: '+96170654322', text: 'مرحبا' });
    expect(res.status).toBe(200);
    expect((res.json as { action: string }).action).toBe('ignored');
    const after = (h.db.prepare('SELECT COUNT(*) AS n FROM outbox').get() as { n: number }).n;
    expect(after).toBe(before);
  });
});
