/**
 * Staff password reset by email.
 *
 * Staff (owner, doctor, and the other `users` roles) authenticate with a
 * scrypt password held in SQLite. This issues a single-use, expiring, hashed
 * token and mails a link to it. Patients are deliberately out of scope: they
 * have no password at all, they sign in with a phone number plus an access code
 * that staff generate (see `routes/patientapp.ts`). "Reset via WhatsApp" for a
 * patient would mean trusting a phone number to prove identity, which is a
 * different - and much weaker - security model than an emailed token.
 *
 * Two rules shape the code:
 *
 * - The response never reveals whether an address is registered. A reset
 *   endpoint that says "no such user" is an account-enumeration oracle, and this
 *   is a medical system where the list of staff addresses is itself sensitive.
 * - The token is stored as SHA-256 only, so a database copy cannot be replayed.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { createId } from '@mediflow/shared';

import type { Db } from '../db/index.js';

/** Long enough that a token found in a mailbox months later is inert. */
const TOKEN_TTL_MINUTES = 30;
const MAX_TOKENS_PER_DAY = 5;

export interface ResetIssueResult {
  /** The raw token. Returned once, to the mailer, and never stored. */
  token: string;
  userId: string;
  email: string;
  fullName: string;
  expiresAt: string;
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Issues a reset token for `email`, or returns null when there is no such
 * account, it is inactive, or the daily limit is reached.
 *
 * The caller sends the same reply either way. Returning null for "rate limited"
 * as well as "unknown user" keeps the two indistinguishable.
 */
export function issuePasswordReset(
  db: Db,
  email: string,
  now: Date = new Date(),
): ResetIssueResult | null {
  const user = db
    .prepare(
      `SELECT id, email, full_name, role, is_active FROM users WHERE email = ?`,
    )
    .get(email) as
    | { id: string; email: string; full_name: string; role: string; is_active: number }
    | undefined;

  if (!user || user.is_active !== 1) return null;

  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + TOKEN_TTL_MINUTES * 60_000).toISOString();

  // Throttle per account so one mailbox cannot be used to spam the SMTP relay.
  const recent = db
    .prepare(
      `SELECT COUNT(*) AS n FROM password_reset_tokens
        WHERE user_id = ? AND created_at > ?`,
    )
    .get(user.id, new Date(now.getTime() - 24 * 60 * 60_000).toISOString()) as { n: number };
  if (recent.n >= MAX_TOKENS_PER_DAY) return null;

  // Any earlier live token stops working the moment a new one is issued, so a
  // forwarded "reset your password" mail is only ever good for the last send.
  db.prepare(
    `UPDATE password_reset_tokens SET used_at = ? WHERE user_id = ? AND used_at IS NULL`,
  ).run(createdAt, user.id);

  const token = randomBytes(32).toString('base64url');
  db.prepare(
    `INSERT INTO password_reset_tokens (id, user_id, token_hash, created_at, expires_at, used_at)
     VALUES (?, ?, ?, ?, ?, NULL)`,
  ).run(createId('prt'), user.id, sha256Hex(token), createdAt, expiresAt);

  return {
    token,
    userId: user.id,
    email: user.email,
    fullName: user.full_name,
    expiresAt,
  };
}

export interface ResetVerifyResult {
  ok: boolean;
  reason?: 'invalid' | 'expired' | 'used';
  userId?: string;
}

/** Checks a token without consuming it, so the reset page can show a real error. */
export function verifyPasswordReset(db: Db, token: string, now: Date = new Date()): ResetVerifyResult {
  const row = db
    .prepare(
      `SELECT id, user_id, expires_at, used_at FROM password_reset_tokens WHERE token_hash = ?`,
    )
    .get(sha256Hex(token)) as
    | { id: string; user_id: string; expires_at: string; used_at: string | null }
    | undefined;

  if (!row) return { ok: false, reason: 'invalid' };
  if (row.used_at) return { ok: false, reason: 'used' };
  if (Date.parse(row.expires_at) <= now.getTime()) return { ok: false, reason: 'expired' };
  return { ok: true, userId: row.user_id };
}

/**
 * Consumes a token and sets the new password.
 *
 * Single use is enforced here in the same statement batch as the hash write, so
 * a token cannot be redeemed twice even if two requests arrive together.
 */
export async function redeemPasswordReset(
  db: Db,
  token: string,
  newPassword: string,
  now: Date = new Date(),
): Promise<{ ok: boolean; reason?: ResetVerifyResult['reason'] }> {
  const check = verifyPasswordReset(db, token, now);
  if (!check.ok) return { ok: false, reason: check.reason };

  const row = db
    .prepare(`SELECT id, user_id FROM password_reset_tokens WHERE token_hash = ?`)
    .get(sha256Hex(token)) as { id: string; user_id: string };

  const consumedAt = now.toISOString();
  // The `used_at IS NULL` guard makes the update the single-use gate: whoever
  // clears it first wins, and the loser's changes count is 0.
  const claimed = db
    .prepare(
      `UPDATE password_reset_tokens SET used_at = ? WHERE id = ? AND used_at IS NULL`,
    )
    .run(consumedAt, row.id);
  if (claimed.changes !== 1) return { ok: false, reason: 'used' };

  // Imported lazily to keep this module free of a cycle with auth/password.
  const { hashPassword } = await import('../auth/password.js');
  const hash = await hashPassword(newPassword);
  db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').run(
    hash,
    consumedAt,
    row.user_id,
  );

  return { ok: true };
}

/** Constant-time compare helper, exported for tests and reuse. */
export function tokensEqual(a: string, b: string): boolean {
  const left = Buffer.from(sha256Hex(a), 'hex');
  const right = Buffer.from(sha256Hex(b), 'hex');
  return timingSafeEqual(left, right);
}
