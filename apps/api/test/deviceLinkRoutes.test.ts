/**
 * Route-level tests for the device-linking endpoints.
 *
 * The service tests cover what goes over the wire; these cover the part a
 * service test cannot see: that the routes require authentication, that they
 * demand `whatsapp:write` rather than a read-only capability, and that the
 * clinic id sent to the gateway is the one on the caller's session rather than
 * anything the request supplied.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { asClient, createHarness, OWNER_EMAIL, OWNER_PASSWORD, type Harness } from './harness.js';

let harness: Harness;
let fetchMock: ReturnType<typeof vi.fn>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const CONFIG = {
  gatewayUrl: 'https://gateway.example.com',
  gatewayAdminToken: 'admin-token-abc',
};

beforeEach(async () => {
  fetchMock = vi.fn().mockResolvedValue(jsonResponse({ state: 'pairing', qr: 'QR-PAYLOAD' }));
  vi.stubGlobal('fetch', fetchMock);
  harness = await createHarness(CONFIG);
});

afterEach(async () => {
  await harness.close();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('GET /whatsapp/device', () => {
  it('requires authentication', async () => {
    const res = await harness.app.inject({ method: 'GET', url: '/whatsapp/device' });
    expect(res.statusCode).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns the gateway session for the caller clinic', async () => {
    const { auth } = await harness.login();
    const res = await asClient(harness.app, auth).get('/whatsapp/device');
    expect(res.statusCode).toBe(200);
    expect(res.json().qr).toBe('QR-PAYLOAD');
  });

  it('forwards the session clinic id, not one from the request', async () => {
    const { auth } = await harness.login();
    await asClient(harness.app, auth).get('/whatsapp/device?clinicId=someone-else');
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://gateway.example.com/api/clinics/${harness.clinic.clinicId}`);
    expect(url).not.toContain('someone-else');
  });

  it('ignores a clinic id in the body', async () => {
    const { auth } = await harness.login();
    const res = await harness.app.inject({
      method: 'GET',
      url: '/whatsapp/device',
      headers: { authorization: auth },
      ...({ payload: { clinicId: 'someone-else' } } as object),
    });
    expect(res.statusCode).toBe(200);
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain(harness.clinic.clinicId);
  });

  it('never leaks the admin token in the response', async () => {
    const { auth } = await harness.login();
    const res = await asClient(harness.app, auth).get('/whatsapp/device');
    expect(res.body).not.toContain('admin-token-abc');
  });

  it('sends the admin token upstream', async () => {
    const { auth } = await harness.login();
    await asClient(harness.app, auth).get('/whatsapp/device');
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer admin-token-abc');
  });

  it('reports 503 when the gateway is down, not 500', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    const { auth } = await harness.login();
    const res = await asClient(harness.app, auth).get('/whatsapp/device');
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('gateway_unavailable');
  });

  it('reports 503 when no gateway is configured', async () => {
    await harness.close();
    harness = await createHarness({ gatewayUrl: null, gatewayAdminToken: null });
    const { auth } = await harness.login();
    const res = await asClient(harness.app, auth).get('/whatsapp/device');
    expect(res.statusCode).toBe(503);
  });
});

describe('POST /whatsapp/device/pairing-code', () => {
  it('requires authentication', async () => {
    const res = await harness.app.inject({ method: 'POST', url: '/whatsapp/device/pairing-code' });
    expect(res.statusCode).toBe(401);
  });

  it('returns the code from the gateway', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ pairingCode: '12345678' }));
    const { auth } = await harness.login();
    const res = await asClient(harness.app, auth).post('/whatsapp/device/pairing-code');
    expect(res.statusCode).toBe(200);
    expect(res.json().pairingCode).toBe('12345678');
  });

  it('posts with no phone number in the body', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ pairingCode: '1' }));
    const { auth } = await harness.login();
    await asClient(harness.app, auth).post('/whatsapp/device/pairing-code', { phoneNumber: '15551230000' });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    // Only an empty object is forwarded: the gateway pairs its configured number.
    expect(init.body).toBe('{}');
  });

  it('maps a gateway refusal to 502', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'unauthorized' }, 401));
    const { auth } = await harness.login();
    const res = await asClient(harness.app, auth).post('/whatsapp/device/pairing-code');
    expect(res.statusCode).toBe(502);
  });

  it('refuses a nurse: whatsapp:write is not enough to link a device', async () => {
    const created = await asClient(harness.app, (await harness.login()).auth).post('/staff', {
      email: 'nurse@mediflow.test',
      password: 'NursePass!2026',
      fullName: 'Nurse One',
      role: 'nurse',
    });
    expect(created.statusCode).toBeLessThan(300);

    const { auth } = await harness.login('nurse@mediflow.test', 'NursePass!2026');
    const res = await asClient(harness.app, auth).get('/whatsapp/device');
    // A nurse holds whatsapp:write, but the pairing QR is the clinic's whole
    // WhatsApp account, so only settings:write (owner) gets it.
    expect(res.statusCode).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a doctor, who holds whatsapp:write but not settings:write', async () => {
    const created = await asClient(harness.app, (await harness.login()).auth).post('/staff', {
      email: 'doctor@mediflow.test',
      password: 'DoctorPass!2026',
      fullName: 'Doctor One',
      role: 'doctor',
    });
    expect(created.statusCode).toBeLessThan(300);

    const { auth } = await harness.login('doctor@mediflow.test', 'DoctorPass!2026');
    const res = await asClient(harness.app, auth).post('/whatsapp/device/pairing-code');
    expect(res.statusCode).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('allows the owner', async () => {
    const { auth } = await harness.login(OWNER_EMAIL, OWNER_PASSWORD);
    expect((await asClient(harness.app, auth).get('/whatsapp/device')).statusCode).toBe(200);
  });
});

describe('clinic isolation', () => {
  it('every forwarded call carries only the caller\'s own clinic id', async () => {
    const { auth } = await harness.login();
    await asClient(harness.app, auth).get('/whatsapp/device');
    await asClient(harness.app, auth).post('/whatsapp/device/pairing-code');

    const urls = fetchMock.mock.calls.map((c) => (c as [string, RequestInit])[0]);
    expect(urls.length).toBe(2);
    for (const url of urls) {
      expect(url).toContain(harness.clinic.clinicId);
      // No other clinic's id can appear: there is no second one, and none can
      // be injected through a query string.
      expect(url).not.toMatch(/someone-else|other-clinic/);
    }
  });
});
