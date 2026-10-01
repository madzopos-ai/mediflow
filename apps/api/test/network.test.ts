/**
 * Patient network: one identity per phone across clinics.
 *
 * The properties that matter: phone is the unique key (re-registering never
 * forks), a clinic sees nothing until a link exists, opening the shared
 * record audits the access, and every row carries its home clinic.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { asClient, createHarness, type Harness } from './harness.js';
import { seed } from '../src/db/seed.js';

describe('patient network', () => {
  let h: Harness;
  let api: ReturnType<typeof asClient>;
  let clinicB: string;
  let apiB: ReturnType<typeof asClient>;
  let networkId: string;

  beforeAll(async () => {
    h = await createHarness();
    api = asClient(h.app, (await h.login()).auth);
    const second = await seed(h.db, {
      clinicName: 'Second Clinic',
      ownerEmail: 'owner2@mediflow.test',
      ownerPassword: 'ChangeMe!2026',
    });
    clinicB = second.clinicId;
    apiB = asClient(h.app, (await h.login('owner2@mediflow.test', 'ChangeMe!2026')).auth);
  });

  afterAll(async () => {
    await h.close();
  });

  it('registers one identity per phone', async () => {
    const first = await h.app.inject({
      method: 'POST',
      url: '/network/register',
      payload: {
        phone: '+96170000001',
        firstName: 'Layla',
        lastName: 'Haddad',
        code: '123456',
        dateOfBirth: '1990-04-04',
        bloodGroup: 'A+',
        chronicConditions: ['diabetes'],
      },
    });
    expect(first.statusCode).toBe(201);
    networkId = (first.json() as { id: string }).id;

    const again = await h.app.inject({
      method: 'POST',
      url: '/network/register',
      payload: { phone: '+961 70 000 001', firstName: 'Other', lastName: 'Name', code: '654321' },
    });
    expect(again.statusCode).toBe(201);
    expect((again.json() as { id: string }).id).toBe(networkId);
  });

  it('looks up by phone without leaking clinical data', async () => {
    const missing = await api.get('/network/lookup?phone=%2B96179999999');
    expect(missing.statusCode).toBe(200);
    expect((missing.json() as { registered: boolean }).registered).toBe(false);

    const found = await api.get('/network/lookup?phone=%2B96170000001');
    expect(found.statusCode).toBe(200);
    const body = found.json() as {
      registered: boolean;
      profile: { fullName: string };
      linkedLocalPatientId: string | null;
    };
    expect(body.registered).toBe(true);
    expect(body.profile.fullName).toBe('Layla Haddad');
    expect(body.linkedLocalPatientId).toBeNull();
    expect(JSON.stringify(body)).not.toContain('vitals');
  });

  it('imports into clinic A with the profile prefilled', async () => {
    const imported = await api.post('/network/import', { networkPatientId: networkId });
    expect(imported.statusCode).toBe(201);
    const body = imported.json() as { localPatientId: string; reused: boolean };
    expect(body.reused).toBe(false);

    const local = await api.get(`/patients/${body.localPatientId}`);
    expect(local.statusCode).toBe(200);
    expect((local.json() as { phone: string }).phone).toBe('+96170000001');
  });

  it('shows clinic A history to clinic B after import, with provenance', async () => {
    // History written in clinic A.
    const lookupA = await api.get('/network/lookup?phone=%2B96170000001');
    const localA = (lookupA.json() as { linkedLocalPatientId: string }).linkedLocalPatientId;
    const vitals = await api.post('/vitals', {
      patientId: localA,
      readings: [{ kind: 'hba1c', value: 8.4 }],
    });
    expect(vitals.statusCode).toBe(201);

    // Clinic B knew nothing before importing.
    const before = await apiB.get('/network/lookup?phone=%2B96170000001');
    expect((before.json() as { linkedLocalPatientId: string | null }).linkedLocalPatientId).toBeNull();

    const imported = await apiB.post('/network/import', { networkPatientId: networkId });
    expect(imported.statusCode).toBe(201);

    const record = await apiB.get(`/network/patients/${networkId}/record`);
    expect(record.statusCode).toBe(200);
    const body = record.json() as {
      profile: { fullName: string };
      clinics: { clinicId: string; clinicName: string; vitals: { kind: string; value: number }[] }[];
    };
    expect(body.profile.fullName).toBe('Layla Haddad');
    expect(body.clinics.length).toBe(2);
    const fromA = body.clinics.find((c) => c.clinicId !== clinicB);
    expect(fromA?.clinicName).toBeTruthy();
    expect(fromA?.vitals.find((v) => v.kind === 'hba1c')?.value).toBe(8.4);

    // The access left an audit trail in the reading clinic.
    const audit = h.db
      .prepare(
        "SELECT COUNT(*) AS n FROM audit_log WHERE clinic_id = ? AND action = 'network.record.open'",
      )
      .get(clinicB) as { n: number };
    expect(audit.n).toBeGreaterThan(0);
  });

  it('signs the patient in on the network and books across clinics', async () => {
    const login = await h.app.inject({
      method: 'POST',
      url: '/auth/network',
      payload: { phone: '+96170000001', code: '123456' },
    });
    expect(login.statusCode).toBe(200);
    const token = (login.json() as { token: string }).token;
    const pat = asClient(h.app, `Bearer ${token}`);

    const record = await pat.get('/patient/me/record');
    expect(record.statusCode).toBe(200);
    expect(((record.json() as { clinics: unknown[] }).clinics.length)).toBe(2);

    const slots = await h.app.inject({ method: 'GET', url: '/public/mediflow-demo-clinic/slots?days=21' });
    const days = (slots.json() as { days: { slots: { startsAt: string }[] }[] }).days;
    const start = days.flatMap((d) => d.slots)[4]?.startsAt;
    expect(start).toBeTruthy();
    const booked = await pat.post('/patient/me/appointments', { clinicId: clinicB, startsAt: start });
    expect(booked.statusCode).toBe(201);
    expect((booked.json() as { patientName: string }).patientName).toBe('Layla Haddad');

    const wrong = await h.app.inject({
      method: 'POST',
      url: '/auth/network',
      payload: { phone: '+96170000001', code: '000000' },
    });
    expect(wrong.statusCode).toBe(401);
  });

  it('publishes a directory without anything clinical', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/directory' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { clinics: { name: string; slug: string }[]; doctors: unknown[] };
    expect(body.clinics.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(body)).not.toContain('@');
  });

  it('stores doctor specialties and lets patients edit their profile', async () => {
    const created = await api.post('/staff', {
      email: 'eye@mediflow.test',
      password: 'Doctor!2026pass',
      fullName: 'Eye Doctor',
      role: 'doctor',
      specialty: 'ophthalmology',
    });
    expect(created.statusCode).toBe(200);

    const dir = await h.app.inject({ method: 'GET', url: '/directory' });
    const doctors = (dir.json() as { doctors: { name: string; specialty: string | null }[] }).doctors;
    expect(doctors.find((d) => d.name === 'Eye Doctor')?.specialty).toBe('ophthalmology');

    const login = await h.app.inject({
      method: 'POST',
      url: '/auth/network',
      payload: { phone: '+96170000001', code: '123456' },
    });
    const token = (login.json() as { token: string }).token;
    const pat = asClient(h.app, `Bearer ${token}`);
    const patched = await pat.patch('/patient/me/profile', { city: 'Beirut', bloodGroup: 'A+' });
    expect(patched.statusCode).toBe(200);
    expect((patched.json() as { city: string }).city).toBe('Beirut');
  });

  it('serves per-doctor availability on the public slots', async () => {
    const eye = await api.post('/staff', {
      email: 'eyedoc2@mediflow.test',
      password: 'Doctor!2026pass',
      fullName: 'Eye Doctor Two',
      role: 'doctor',
      specialty: 'ophthalmology',
    });
    const doctorId = (eye.json() as { id: string }).id;

    const res = await h.app.inject({
      method: 'GET',
      url: `/public/mediflow-demo-clinic/slots?days=7&doctorId=${doctorId}`,
    });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray((res.json() as { days: unknown[] }).days)).toBe(true);

    const foreign = await h.app.inject({
      method: 'GET',
      url: '/public/mediflow-demo-clinic/slots?days=7&doctorId=usr_does_not_exist',
    });
    expect(foreign.statusCode).toBe(200);
    expect((foreign.json() as { days: unknown[] }).days).toEqual([]);
  });

  it('stores and serves the patient photo with the right audience', async () => {
    const login = await h.app.inject({
      method: 'POST',
      url: '/auth/network',
      payload: { phone: '+96170000001', code: '123456' },
    });
    const pat = asClient(h.app, `Bearer ${(login.json() as { token: string }).token}`);
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64');
    const up = await pat.post('/patient/me/avatar', { mimeType: 'image/png', fileBase64: png });
    expect(up.statusCode).toBe(201);

    const me = await pat.get('/patient/me/profile');
    expect((me.json() as { avatarUrl: string }).avatarUrl).toContain('/network/avatars/');

    const mine = await pat.get(`/network/avatars/${networkId}`);
    expect(mine.statusCode).toBe(200);

    // Anonymous viewers get nothing (401 at the gate), not even existence.
    const anon = await h.app.inject({ method: 'GET', url: `/network/avatars/${networkId}` });
    expect(anon.statusCode).toBe(401);
  });
});
