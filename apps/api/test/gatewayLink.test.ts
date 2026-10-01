/**
 * Device-linking proxy tests.
 *
 * The invariant worth protecting: the gateway's admin token stays on the server
 * and the clinic is taken from the session, never from the request. A regression
 * in either would let a signed-in user read another clinic's pairing code, so
 * these assert on what was forwarded to the gateway, not just the response.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { loadConfig, type Config } from '../src/config.js';
import { gatewayPairingCode, gatewaySession } from '../src/services/gateway.js';

function configWith(overrides: Partial<NodeJS.ProcessEnv> = {}): Config {
  return loadConfig({
    NODE_ENV: 'test',
    JWT_SECRET: 'x'.repeat(40),
    ENCRYPTION_KEY: 'y'.repeat(40),
    WHATSAPP_PROVIDER: 'baileys',
    GATEWAY_URL: 'https://gateway.example.com',
    GATEWAY_ADMIN_TOKEN: 'admin-token-abc',
    ...overrides,
  } as NodeJS.ProcessEnv);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('gateway proxy', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('sends the admin token as a bearer', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ state: 'pairing', qr: 'QR' }));
    await gatewaySession(configWith(), 'clinic-a');
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer admin-token-abc');
  });

  it('never puts the token in the URL', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ state: 'pairing' }));
    await gatewaySession(configWith(), 'clinic-a');
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).not.toContain('admin-token-abc');
  });

  it('scopes the request to the clinic id it was given', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ state: 'connected' }));
    await gatewaySession(configWith(), 'clinic-a');
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://gateway.example.com/api/clinics/clinic-a');
  });

  it('escapes a clinic id so it cannot traverse', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ state: 'connected' }));
    await gatewaySession(configWith(), '../../keys/sa');
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://gateway.example.com/api/clinics/..%2F..%2Fkeys%2Fsa');
  });

  it('strips a trailing slash from the configured url', () => {
    const config = configWith({ GATEWAY_URL: 'https://gateway.example.com/' });
    expect(config.gatewayUrl).toBe('https://gateway.example.com');
  });

  it('normalises the session payload', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ state: 'connected', registered: true, paired: true, qr: null, connectedAt: '2026-01-01T00:00:00Z' }),
    );
    const result = await gatewaySession(configWith(), 'clinic-a');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.state).toBe('connected');
    expect(result.data.paired).toBe(true);
    expect(result.data.qr).toBeNull();
  });

  it('defaults a missing state rather than passing undefined through', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));
    const result = await gatewaySession(configWith(), 'clinic-a');
    expect(result.ok && result.data.state).toBe('unknown');
  });

  it('reports unavailable when no gateway is configured', async () => {
    const result = await gatewaySession(configWith({ GATEWAY_URL: '', GATEWAY_ADMIN_TOKEN: '' }), 'clinic-a');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('unavailable');
    // Nothing should be attempted when there is nowhere to send it.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports unavailable when only the token is set', async () => {
    const result = await gatewaySession(configWith({ GATEWAY_URL: '' }), 'clinic-a');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('unavailable');
  });

  it('reports rejected when the gateway refuses the token', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'unauthorized' }, 401));
    const result = await gatewaySession(configWith(), 'clinic-a');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('rejected');
    expect(result.message).toMatch(/GATEWAY_ADMIN_TOKEN/);
  });

  it('explains a gateway with pairing disabled', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'gateway_api_disabled' }, 503));
    const result = await gatewaySession(configWith(), 'clinic-a');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/disabled/i);
  });

  it('reports unavailable when the network fails', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    const result = await gatewaySession(configWith(), 'clinic-a');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('unavailable');
  });

  it('reports unavailable on timeout rather than hanging', async () => {
    fetchMock.mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    const result = await gatewaySession(configWith(), 'clinic-a');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/time/i);
  });

  it('surfaces a 500 from the gateway as rejected', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'boom' }, 500));
    const result = await gatewaySession(configWith(), 'clinic-a');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('rejected');
  });

  it('posts for a pairing code and returns it', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ pairingCode: '12345678' }));
    const result = await gatewayPairingCode(configWith(), 'clinic-a');
    expect(result.ok && result.data.pairingCode).toBe('12345678');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://gateway.example.com/api/clinics/clinic-a/pairing-code');
    expect(init.method).toBe('POST');
  });

  it('rejects an empty pairing code instead of passing it to the UI', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ pairingCode: '' }));
    const result = await gatewayPairingCode(configWith(), 'clinic-a');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('rejected');
  });

  it('does not forward a phone number when asking for a code', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ pairingCode: '1' }));
    await gatewayPairingCode(configWith(), 'clinic-a');
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    // An empty object, never a number: the gateway pairs its own configured one.
    expect(init.body).toBe('{}');
  });
});
