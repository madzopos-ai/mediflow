/**
 * Login, session, and staff management.
 *
 * Login is deliberately slow on failure: a wrong email and a wrong password
 * take the same time, so the endpoint cannot be used to enumerate which
 * accounts exist. The in-memory throttle is per-email-and-IP, and is enough to
 * blunt online guessing for a single-clinic deployment; a multi-instance
 * deployment should back it with Redis.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { MEMBER_ROLES, SPECIALTY_LABELS, createId, type MemberRole } from '@mediflow/shared';

import { ApiError, handler, idSchema, parseBody } from '../http/errors.js';
import { hashPassword, verifyPassword } from '../auth/password.js';
import { FirebaseNotConfigured, exchangeFirebaseSession } from '../auth/firebase.js';
import { requireCapability, requireRole, signSession, type SessionUser } from '../auth/plugin.js';
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import { sendMail } from '../services/mail.js';
import {
  issuePasswordReset,
  redeemPasswordReset,
  verifyPasswordReset,
} from '../services/passwordReset.js';

interface UserRow {
  id: string;
  clinic_id: string;
  email: string;
  password_hash: string;
  full_name: string;
  role: MemberRole;
  locale: string;
  is_active: number;
}

interface Attempt {
  count: number;
  firstAt: number;
  lockedUntil: number;
}

const MAX_ATTEMPTS = 8;
const LOCK_MS = 15 * 60 * 1000;
const WINDOW_MS = 15 * 60 * 1000;

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(1).max(256),
});

const SPECIALTIES = Object.keys(SPECIALTY_LABELS) as [string, ...string[]];

const createStaffSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(10).max(256),
  fullName: z.string().trim().min(2).max(120),
  fullNameAr: z.string().trim().max(120).optional(),
  role: z.enum(MEMBER_ROLES),
  specialty: z.enum(SPECIALTIES).nullable().optional(),
  phone: z.string().trim().max(24).optional(),
  locale: z.enum(['en', 'ar']).default('en'),
});

const updateStaffSchema = z.object({
  fullName: z.string().trim().min(2).max(120).optional(),
  fullNameAr: z.string().trim().max(120).nullable().optional(),
  role: z.enum(MEMBER_ROLES).optional(),
  specialty: z.enum(SPECIALTIES).nullable().optional(),
  isActive: z.boolean().optional(),
  password: z.string().min(10).max(256).optional(),
});

/**
 * `config` and `db` are threaded in as a closure rather than Fastify plugin
 * options: Fastify types the options bag as its own `Config`, and our Config's
 * `logLevel` is a plain string that collides with Fastify's `LevelWithSilent`.
 */
export async function registerAuthRoutes(
  app: FastifyInstance,
  { config, db }: { config: Config; db: Db },
): Promise<void> {
  const attempts = new Map<string, Attempt>();

  function throttleKey(email: string, ip: string): string {
    return `${email}|${ip}`;
  }

  function checkThrottle(key: string): void {
    const now = Date.now();
    const entry = attempts.get(key);
    if (!entry) return;
    if (entry.lockedUntil > now) {
      const seconds = Math.ceil((entry.lockedUntil - now) / 1000);
      throw new ApiError(429, 'rate_limited', `Too many attempts. Try again in ${seconds}s.`);
    }
    if (now - entry.firstAt > WINDOW_MS) {
      // The window has passed; start counting again.
      attempts.delete(key);
    }
  }

  function recordFailure(key: string): void {
    const now = Date.now();
    const entry = attempts.get(key);
    if (!entry || now - entry.firstAt > WINDOW_MS) {
      attempts.set(key, { count: 1, firstAt: now, lockedUntil: 0 });
      return;
    }
    entry.count += 1;
    if (entry.count >= MAX_ATTEMPTS) {
      entry.lockedUntil = now + LOCK_MS;
    }
    attempts.set(key, entry);
  }

  app.post(
    '/auth/login',
    { config: { public: true } },
    handler(async (request) => {
      const body = parseBody(request, loginSchema, 'login credentials');
      const ip = request.ip;
      const key = throttleKey(body.email, ip);
      checkThrottle(key);

      const row = app.database
        .prepare(
          `SELECT id, clinic_id, email, password_hash, full_name, role, locale, is_active, is_reseller
              FROM users WHERE email = ?`,
        )
        .get(body.email) as (UserRow & { is_active: number; is_reseller: number }) | undefined;

      // Always run a hash comparison, even when the user does not exist, so
      // response time does not reveal whether the email is registered.
      const storedHash = row?.password_hash ?? DUMMY_HASH;
      const passwordOk = await verifyPassword(body.password, storedHash);

      if (!row || !passwordOk) {
        recordFailure(key);
        throw ApiError.unauthorized('Incorrect email or password.');
      }
      // Pending accounts fail closed with an explicit reason: a doctor who
      // joined but was not approved yet must know to wait, not to retry
      // their password forever.
      if (row.is_active !== 1) {
        throw new ApiError(
          403,
          'pending_approval',
          'Account pending approval. The administrator reviews every new practice before it can sign in.',
        );
      }
      const clinic = app.database.prepare('SELECT is_active FROM clinics WHERE id = ?').get(row.clinic_id) as
        | { is_active: number }
        | undefined;
      if (!clinic || clinic.is_active !== 1) {
        throw new ApiError(403, 'clinic_suspended', 'This practice is suspended. Contact the administrator.');
      }

      attempts.delete(key);

      const user: SessionUser = {
        id: row.id,
        clinicId: row.clinic_id,
        email: row.email,
        fullName: row.full_name,
        role: row.role,
        locale: row.locale,
        isReseller: Number(row.is_reseller) === 1,
      };

      const now = new Date().toISOString();
      app.database
        .prepare('UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?')
        .run(now, now, row.id);

      return { token: signSession(app, user), user };
    }),
  );

  app.get(
    '/auth/me',
    handler(async (request) => {
      const me = request.tenant.user;
      if (!me) throw ApiError.unauthorized();
      // Fresh completeness for the onboarding gate: a session minted before
      // the profile was finished must not look finished.
      const row = app.database
        .prepare('SELECT phone, address, specialty, role FROM users WHERE id = ?')
        .get(me.id) as { phone: string | null; address: string | null; specialty: string | null; role: string } | undefined;
      return {
        ...me,
        phone: row?.phone ?? null,
        specialty: row?.specialty ?? null,
        profileComplete: !!(row?.phone && row?.address && (row?.role !== 'doctor' || row?.specialty)),
      };
    }),
  );

  /**
   * Firebase exchange: a Firebase ID token becomes an API session.
   * Public by necessity - this *is* a login route. The ID token is verified
   * against the Firebase project and the staff doc decides the role; a forged
   * or foreign token fails verification before anything is provisioned.
   */
  app.post(
    '/auth/firebase',
    { config: { public: true } },
    handler(async (request) => {
      const body = parseBody(request, z.object({ idToken: z.string().min(1).max(4096) }), 'firebase token');
      try {
        return await exchangeFirebaseSession(app, app.database, body.idToken);
      } catch (error) {
        if (error instanceof FirebaseNotConfigured) {
          throw ApiError.badRequest('Firebase sign-in is not enabled on this server.');
        }
        throw ApiError.unauthorized(error instanceof Error ? error.message : 'Firebase sign-in failed.');
      }
    }),
  );

  app.post(
    '/auth/password',
    { preHandler: requireRole('assistant') },
    handler(async (request) => {
      const body = parseBody(
        request,
        z.object({ currentPassword: z.string().min(1).max(256), newPassword: z.string().min(10).max(256) }),
        'password change',
      );
      const me = request.tenant.user;
      if (!me) throw ApiError.unauthorized();

      const row = app.database
        .prepare('SELECT password_hash FROM users WHERE id = ? AND clinic_id = ?')
        .get(me.id, me.clinicId) as { password_hash: string } | undefined;
      if (!row) throw ApiError.notFound('User not found.');

      const ok = await verifyPassword(body.currentPassword, row.password_hash);
      if (!ok) throw ApiError.badRequest('Current password is incorrect.');

      const hash = await hashPassword(body.newPassword);
      const now = new Date().toISOString();
      app.database
        .prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ? AND clinic_id = ?')
        .run(hash, now, me.id, me.clinicId);

      return { ok: true };
    }),
  );

  app.get(
    '/staff',
    { preHandler: requireCapability('settings:read') },
    handler(async (request) => {
      const rows = request.tenant.db.page<Record<string, unknown>>('users', {
        orderBy: 'full_name COLLATE NOCASE',
        limit: 200,
        offset: 0,
      });
      // Password hashes never leave the server, even to fellow staff.
      return {
        items: rows.map((r) => ({
          id: String(r['id']),
          email: String(r['email']),
          fullName: String(r['full_name']),
          role: String(r['role']),
          specialty: r['specialty'] ? String(r['specialty']) : null,
          phone: r['phone'] ? String(r['phone']) : null,
          locale: String(r['locale'] ?? 'en'),
          isActive: Number(r['is_active']) === 1,
          lastLoginAt: r['last_login_at'] ? String(r['last_login_at']) : null,
          createdAt: String(r['created_at']),
        })),
      };
    }),
  );

  app.post(
    '/staff',
    { preHandler: requireCapability('staff:manage') },
    handler(async (request) => {
      const body = parseBody(request, createStaffSchema, 'staff member');
      const now = new Date().toISOString();
      const id = createId('usr');
      const hash = await hashPassword(body.password);

      // The owner email is unique per clinic, and the write goes through the
      // tenant handle so the clinic_id cannot be spoofed.
      request.tenant.db.insert('users', {
        id,
        clinic_id: request.tenant.clinicId,
        email: body.email,
        password_hash: hash,
        full_name: body.fullName,
        full_name_ar: body.fullNameAr ?? null,
        role: body.role,
        specialty: body.role === 'doctor' ? (body.specialty ?? null) : null,
        phone: body.phone ?? null,
        locale: body.locale,
        is_active: 1,
        last_login_at: null,
        created_at: now,
        updated_at: now,
      });

      return { id, email: body.email, role: body.role };
    }),
  );

  app.patch(
    '/staff/:id',
    { preHandler: requireCapability('staff:manage') },
    handler(async (request) => {
      const params = parseBody(
        request,
        z.object({ id: idSchema }),
        'path parameters',
      );
      const body = parseBody(request, updateStaffSchema, 'staff update');
      const existing = request.tenant.db.get<{ id: string; role: MemberRole }>('users', params.id);
      if (!existing) throw ApiError.notFound('Staff member not found.');

      const values: Record<string, string | number | null> = { updated_at: new Date().toISOString() };
      if (body.fullName !== undefined) values['full_name'] = body.fullName;
      if (body.fullNameAr !== undefined) values['full_name_ar'] = body.fullNameAr;
      if (body.role !== undefined) values['role'] = body.role;
      if (body.specialty !== undefined) values['specialty'] = body.specialty;
      if (body.isActive !== undefined) values['is_active'] = body.isActive ? 1 : 0;
      if (body.password !== undefined) values['password_hash'] = await hashPassword(body.password);

      // Guard against a clinic ending up with no active owner, which would
      // lock everyone out of staff management permanently.
      if ((body.role !== undefined && body.role !== 'owner') || body.isActive === false) {
        if (existing.role === 'owner') {
          const others = request.tenant.db.count(
            'users',
            "role = 'owner' AND is_active = 1 AND id != ?",
            [params.id],
          );
          if (others === 0) {
            throw ApiError.conflict('A clinic must keep at least one active owner.');
          }
        }
      }

      request.tenant.db.update('users', params.id, values);
      return { ok: true };
    }),
  );

  registerPasswordResetRoutes(app, {
    config,
    db,
    throttleKey,
    checkThrottle,
    recordFailure,
  });
}

interface ResetGuard {
  config: Config;
  db: Db;
  throttleKey(email: string, ip: string): string;
  checkThrottle(key: string): void;
  recordFailure(key: string): void;
}

/**
 * Staff password reset by email.
 *
 * Patients are not served here: they have no password, only a phone number and
 * a staff-issued access code. See `services/passwordReset.ts` for why a reset
 * token is the right shape for staff and a phone number is not.
 */
function registerPasswordResetRoutes(app: FastifyInstance, guard: ResetGuard): void {
  const { config, db } = guard;
  const forgetSchema = z.object({ email: z.string().trim().toLowerCase().email().max(254) });
  const redeemSchema = z.object({
    token: z.string().trim().min(10).max(200),
    password: z.string().min(10).max(256),
  });

  /** Same answer whether or not the address is registered, and always 200. */
  const ACK = {
    ok: true,
    message: 'If that address belongs to an active staff account, a reset link is on its way.',
  };

  app.post(
    '/auth/password/forgot',
    { config: { public: true } },
    handler(async (request) => {
      const body = parseBody(request, forgetSchema, 'reset request');

      // Throttle on the same key as login, so this cannot be used to spray
      // reset mail at one address any faster than guessing its password.
      const key = guard.throttleKey(body.email, request.ip);
      guard.checkThrottle(key);
      guard.recordFailure(key);

      const mail = config.smtp;
      if (!mail) {
        // 503 rather than a silent 200: a user told to check their inbox when
        // no mail was sent would wait for an hour and then file a ticket. This
        // is an operator misconfiguration, not the caller's fault.
        throw new ApiError(
          503,
          'mail_not_configured',
          'Password reset by email is not available. Contact your clinic administrator.',
        );
      }

      const issue = issuePasswordReset(db, body.email);
      if (issue) {
        const link = resetLinkFor(config.publicWebUrl, issue.token);
        const result = await sendMail(mail, {
          to: issue.email,
          subject: 'Reset your MediFlow password',
          text: [
            `Hello ${issue.fullName},`,
            '',
            'Someone requested a password reset for your MediFlow staff account.',
            'Open this link to choose a new password:',
            '',
            link,
            '',
            `The link expires at ${issue.expiresAt} and can only be used once.`,
            '',
            'If you did not request this, you can ignore this email: your',
            'password will not change until someone opens the link.',
          ].join('\n'),
        });
        if (!result.ok) {
          // Log the reason but do not tell the caller: the reply is the same
          // either way, and this is an operator problem to fix in the logs.
          request.log.error({ err: result.error }, 'password reset email failed');
        }
      }

      return ACK;
    }),
  );

  // Confirms a token is live so the reset page can say "expired" instead of
  // letting someone type a new password that is then rejected.
  app.get(
    '/auth/password/reset',
    { config: { public: true } },
    handler(async (request) => {
      const query = request.query as { token?: string };
      const token = String(query.token ?? '').trim();
      if (token.length < 10) throw ApiError.badRequest('Missing reset token.');
      const check = verifyPasswordReset(db, token);
      if (!check.ok) {
        throw new ApiError(400, `reset_${check.reason ?? 'invalid'}`, 'This reset link is no longer valid.');
      }
      return { ok: true };
    }),
  );

  app.post(
    '/auth/password/reset',
    { config: { public: true } },
    handler(async (request) => {
      const body = parseBody(request, redeemSchema, 'reset submission');
      const result = await redeemPasswordReset(db, body.token, body.password);
      if (!result.ok) {
        throw new ApiError(
          400,
          `reset_${result.reason ?? 'invalid'}`,
          'This reset link is no longer valid.',
        );
      }
      return { ok: true, message: 'Password updated. You can sign in now.' };
    }),
  );
}

/**
 * Builds the link a person clicks.
 *
 * The token goes in the fragment, not the query string. Fragments are not sent
 * to servers or written to access logs on the way to `/auth/password/reset`,
 * where a leaked query token would be a standing password-reset capability for
 * anyone holding the link.
 */
function resetLinkFor(base: string, token: string): string {
  return `${base}/#/password-reset?token=${encodeURIComponent(token)}`;
}

/**
 * A real, well-formed scrypt hash of a random value, used to equalise timing
 * on unknown accounts. `verifyPassword` rejects malformed hashes *before*
 * running scrypt, so a placeholder string would make unknown emails measurably
 * faster than wrong passwords and leak account existence. Never used to
 * authenticate anything.
 */
const DUMMY_HASH =
  'scrypt$16384$8$1$+pTTB3IbGBsGXysAUug9TA==$zNkqdlQ8/9M20DSWlu2xga31l7GIekfL8VtYQIt3ORsnhmDuozyQssMMyl4ByzG167Im+6J5FiL2u94zEOS/pQ==';
