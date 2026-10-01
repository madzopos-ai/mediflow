/**
 * Public join: facility type, specialty, email verification, own password.
 *
 * Joining happens in two steps because the email must be proven before
 * anything exists: first a code goes out (and, outside production, back in
 * the response so local development can complete the flow), then verification
 * creates the clinic and the owner/doctor account in one transaction and
 * signs them straight in. Nothing half-made can ever sign in, because nothing
 * exists until the code checks out.
 */

import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { SPECIALTY_LABELS, createId, slugify, type MemberRole } from '@mediflow/shared';

import { ApiError, handler, parseBody } from '../http/errors.js';
import { hashPassword } from '../auth/password.js';
import type { SessionUser } from '../auth/plugin.js';
import { defaultSchedule, defaultSettings } from '../db/defaults.js';
import { jsonColumn, nullable } from '../db/mappers.js';

const SPECIALTIES = Object.keys(SPECIALTY_LABELS) as [string, ...string[]];
const ACCOUNT_TYPES = ['doctor', 'clinic', 'lab', 'pharmacy'] as const;
const CLINIC_KINDS: Record<(typeof ACCOUNT_TYPES)[number], string> = {
  doctor: 'clinic',
  clinic: 'clinic',
  lab: 'lab',
  pharmacy: 'pharmacy',
};

const codeSchema = z.object({
  accountType: z.enum(ACCOUNT_TYPES),
  email: z.string().trim().toLowerCase().email().max(254),
});

const verifySchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  code: z.string().trim().regex(/^\d{6}$/),
  accountType: z.enum(ACCOUNT_TYPES),
  fullName: z.string().trim().min(2).max(120),
  password: z.string().min(10).max(256),
  specialty: z.enum(SPECIALTIES).nullable().optional(),
  practiceName: z.string().trim().min(2).max(160).optional(),
  phone: z.string().trim().max(24).nullable().optional(),
});

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

const attempts = new Map<string, { count: number; firstAt: number }>();

function throttle(key: string, max: number): void {
  const entry = attempts.get(key);
  if (!entry) return;
  if (Date.now() - entry.firstAt > 3600_000) {
    attempts.delete(key);
    return;
  }
  if (entry.count >= max) throw ApiError.badRequest('Too many attempts. Try again later.');
}

function hit(key: string): void {
  const entry = attempts.get(key);
  if (!entry || Date.now() - entry.firstAt > 3600_000) {
    attempts.set(key, { count: 1, firstAt: Date.now() });
    return;
  }
  entry.count += 1;
  attempts.set(key, entry);
}

export async function registerJoinRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/auth/signup/code',
    { config: { public: true } },
    handler(async (request) => {
      const body = parseBody(request, codeSchema, 'signup');
      throttle(`${request.ip}:code`, 5);
      hit(`${request.ip}:code`);

      const taken = app.database
        .prepare('SELECT id FROM users WHERE email = ? LIMIT 1')
        .get(body.email) as { id: string } | undefined;
      if (taken) throw ApiError.conflict('This email is already registered. Try signing in.');

      const code = String(randomInt(100_000, 1_000_000));
      const now = new Date().toISOString();
      app.database
        .prepare('DELETE FROM signup_codes WHERE email = ?')
        .run(body.email);
      app.database
        .prepare(
          `INSERT INTO signup_codes (id, email, code_hash, payload_json, attempts, expires_at, created_at)
           VALUES (?, ?, ?, ?, 0, ?, ?)`,
        )
        .run(
          createId('sgn'),
          body.email,
          sha256Hex(code),
          JSON.stringify({ accountType: body.accountType }),
          new Date(Date.now() + 30 * 60_000).toISOString(),
          now,
        );
      // In production this is emailed (see the reseller mailer); locally the
      // server log carries it. The response carries it only outside
      // production, so the flow stays testable without an inbox.
      request.log.info({ email: body.email }, 'Signup verification code issued.');
      return {
        ok: true,
        ...(app.config.isProduction ? {} : { devCode: code }),
      };
    }),
  );

  app.post(
    '/auth/signup/verify',
    { config: { public: true } },
    handler(async (request, reply) => {
      const body = parseBody(request, verifySchema, 'signup verification');
      throttle(`${request.ip}:verify`, 10);

      const row = app.database
        .prepare('SELECT * FROM signup_codes WHERE email = ? LIMIT 1')
        .get(body.email) as Record<string, unknown> | undefined;
      const expected = Buffer.from(typeof row?.['code_hash'] === 'string' ? (row['code_hash'] as string) : sha256Hex('none'), 'hex');
      const actual = Buffer.from(sha256Hex(body.code), 'hex');
      const match = row && expected.length === actual.length && timingSafeEqual(expected, actual);
      const live = row && String(row['expires_at']) > new Date().toISOString() && Number(row['attempts'] ?? 0) < 5;
      if (!match || !live) {
        hit(`${request.ip}:verify`);
        if (row) {
          app.database.prepare('UPDATE signup_codes SET attempts = attempts + 1 WHERE id = ?').run(String(row['id']));
        }
        throw ApiError.unauthorized('Incorrect or expired code.');
      }
      const stored = JSON.parse(String(row?.['payload_json'] ?? '{}')) as { accountType?: string };
      if (stored.accountType !== body.accountType) {
        throw ApiError.badRequest('This code was issued for a different account type.');
      }
      if (body.accountType === 'doctor' && !body.specialty) {
        throw ApiError.badRequest('Doctors must pick a specialty.', [
          { path: 'specialty', message: 'Specialty drives the drugs and labs you see first.' },
        ]);
      }

      const kind = CLINIC_KINDS[body.accountType];
      const clinicName =
        body.practiceName ?? (body.accountType === 'doctor' ? `${body.fullName} Clinic` : `${body.fullName}`);
      const slugBase =
        slugify(clinicName, 40) || `clinic-${Date.now().toString(36)}`;
      let slug = slugBase;
      for (let attempt = 1; ; attempt += 1) {
        const clash = app.database.prepare('SELECT id FROM clinics WHERE slug = ?').get(slug) as
          | { id: string }
          | undefined;
        if (!clash) break;
        slug = `${slugBase}-${attempt}`;
      }

      const emailTaken = app.database
        .prepare('SELECT id FROM users WHERE email = ? LIMIT 1')
        .get(body.email) as { id: string } | undefined;
      if (emailTaken) throw ApiError.conflict('This email is already registered. Try signing in.');

      const now = new Date().toISOString();
      const clinicId = createId('clc');
      const userId = createId('usr');
      const role: MemberRole = 'owner';
      const settings = defaultSettings();
      const schedule = defaultSchedule(clinicId, 'en');
      const hash = await hashPassword(body.password.normalize('NFKC'));

      const write = app.database.transaction(() => {
        app.database
          .prepare(
            `INSERT INTO clinics
              (id, name, name_ar, slug, timezone, country, currency, phone, email, address, logo_url,
               kind, is_active, created_at, updated_at)
             VALUES (?, ?, ?, ?, 'Asia/Riyadh', 'SA', 'SAR', ?, ?, NULL, NULL, ?, 0, ?, ?)`,
          )
          .run(clinicId, clinicName, clinicName, slug, body.phone ?? null, body.email, kind, now, now);
        app.database
          .prepare('INSERT INTO clinic_settings (clinic_id, json, updated_at) VALUES (?, ?, ?)')
          .run(clinicId, jsonColumn(settings), now);
        app.database
          .prepare('INSERT INTO clinic_schedules (id, clinic_id, json, updated_at) VALUES (?, ?, ?, ?)')
          .run(schedule.id, clinicId, jsonColumn(schedule), now);
        app.database
          .prepare(
            `INSERT INTO users
              (id, clinic_id, email, password_hash, full_name, role, specialty, phone, address, locale,
               is_active, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'en', 0, ?, ?)`,
          )
          .run(
            userId,
            clinicId,
            body.email,
            hash,
            body.fullName,
            role,
            body.accountType === 'doctor' ? (body.specialty ?? null) : null,
            nullable(body.phone),
            null,
            now,
            now,
          );
        app.database.prepare('DELETE FROM signup_codes WHERE email = ?').run(body.email);
      });
      write();

      const user: SessionUser = {
        id: userId,
        clinicId,
        email: body.email,
        fullName: body.fullName,
        role,
        locale: 'en',
      };
      // No token yet: the reseller approves first. The response says so
      // explicitly instead of failing the first login mysteriously.
      return reply.status(201).send({
        pending: true as const,
        message: 'Account created and pending administrator approval. You will be able to sign in once approved.',
        user,
        accountType: body.accountType,
      });
    }),
  );

  /**
   * The owner fills the rest of their own profile. Limited to safe fields;
   * role, clinic, and email never change here.
   */
  app.patch(
    '/auth/profile',
    handler(async (request) => {
      const me = request.tenant.user;
      if (!me) throw ApiError.unauthorized();
      const body = parseBody(
        request,
        z.object({
          fullName: z.string().trim().min(2).max(120).optional(),
          phone: z.string().trim().max(24).nullable().optional(),
          address: z.string().trim().max(400).nullable().optional(),
          specialty: z.enum(SPECIALTIES).nullable().optional(),
        }),
        'profile',
      );
      const values: Record<string, string | null> = { updated_at: new Date().toISOString() };
      if (body.fullName !== undefined) values['full_name'] = body.fullName;
      if (body.phone !== undefined) values['phone'] = nullable(body.phone);
      if (body.address !== undefined) values['address'] = nullable(body.address);
      if (body.specialty !== undefined) values['specialty'] = nullable(body.specialty);
      app.database
        .prepare(
          `UPDATE users SET ${Object.keys(values)
            .map((c) => `"${c}" = ?`)
            .join(', ')} WHERE id = ? AND clinic_id = ?`,
        )
        .run(...Object.values(values), me.id, me.clinicId);
      const row = app.database
        .prepare('SELECT phone, address, specialty, role FROM users WHERE id = ?')
        .get(me.id) as { phone: string | null; address: string | null; specialty: string | null; role: string };
      return {
        phone: row.phone,
        address: row.address,
        specialty: row.specialty,
        profileComplete: !!(row.phone && row.address && (row.role !== 'doctor' || row.specialty)),
      };
    }),
  );
}
