/**
 * Document bytes: upload stores the file, download serves it back.
 *
 * A scanner that accepts files but silently drops the bytes is worse than no
 * scanner at all, so the round-trip is pinned: bytes in, same bytes out, with
 * the recorded MIME type and the custom title intact.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { asClient, createHarness, type Harness } from './harness.js';

describe('document files', () => {
  let h: Harness;
  let patientId: string;

  beforeAll(async () => {
    h = await createHarness();
    const api = asClient(h.app, (await h.login()).auth);
    const created = await api.post('/patients', {
      firstName: 'Doc',
      lastName: 'Test',
      phone: '+966500000111',
      dateOfBirth: '1990-05-14',
      address: 'Test Street 1',
      heightCm: 175,
      weightKg: 70,
    });
    expect(created.statusCode).toBe(201);
    patientId = created.json().id as string;
  });

  afterAll(async () => {
    await h.close();
  });

  it('stores bytes on upload and serves them back with the MIME type', async () => {
    const api = asClient(h.app, (await h.login()).auth);
    const bytes = Buffer.from('%PDF-1.4 fake-lab-report', 'utf8').toString('base64');
    const up = await api.post('/documents/upload', {
      patientId,
      kind: 'lab_report',
      title: 'HbA1c Q3',
      fileName: 'hba1c.pdf',
      mimeType: 'application/pdf',
      fileBase64: bytes,
    });
    expect(up.statusCode).toBe(201);
    const doc = up.json() as { id: string; title: string; status: string };
    expect(doc.title).toBe('HbA1c Q3');
    expect(doc.status).toBe('stored');

    const down = await api.get(`/documents/${doc.id}/file`);
    expect(down.statusCode).toBe(200);
    expect(down.headers['content-type']).toContain('application/pdf');
    expect(down.body).toBe('%PDF-1.4 fake-lab-report');
  });

  it('rejects content that is not base64', async () => {
    const api = asClient(h.app, (await h.login()).auth);
    const up = await api.post('/documents/upload', {
      patientId,
      kind: 'other',
      fileName: 'bad.bin',
      mimeType: 'application/octet-stream',
      fileBase64: '***not-base64***',
    });
    expect(up.statusCode).toBe(400);
  });

  it('returns 404 for a metadata-only document with no bytes', async () => {
    const api = asClient(h.app, (await h.login()).auth);
    const created = await api.post('/documents', {
      patientId,
      kind: 'other',
      fileName: 'meta-only.txt',
      mimeType: 'text/plain',
      byteSize: 10,
    });
    expect(created.statusCode).toBe(201);
    const id = (created.json() as { id: string }).id;
    const down = await api.get(`/documents/${id}/file`);
    expect(down.statusCode).toBe(404);
  });

  it('deletes a document and its bytes together', async () => {
    const api = asClient(h.app, (await h.login()).auth);
    const bytes = Buffer.from('delete-me', 'utf8').toString('base64');
    const up = await api.post('/documents/upload', {
      patientId,
      kind: 'other',
      fileName: 'doomed.txt',
      mimeType: 'text/plain',
      fileBase64: bytes,
    });
    expect(up.statusCode).toBe(201);
    const id = (up.json() as { id: string }).id;

    const del = await api.del(`/documents/${id}`);
    expect(del.statusCode).toBe(200);

    const down = await api.get(`/documents/${id}/file`);
    expect(down.statusCode).toBe(404);
  });
});
