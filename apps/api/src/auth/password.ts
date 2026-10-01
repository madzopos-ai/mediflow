/**
 * Password hashing.
 *
 * scrypt with per-password random salt, compared in constant time. Chosen over
 * bcrypt/argon2 because it is built into Node with no native dependency to
 * compile, which matters for a self-hosted clinic deployment.
 *
 * Parameters (N=16384, r=8, p=1) are Node's interactive-login defaults, which
 * are meaningfully stronger than the legacy OWASP bcrypt-cost guidance.
 */

import { randomBytes, scrypt as scryptCallback, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: ScryptOptions,
) => Promise<Buffer>;

const KEY_LENGTH = 64;
const SALT_LENGTH = 16;
// scrypt needs roughly 128 * N * r bytes; give it headroom above the default.
const MAX_MEMORY = 64 * 1024 * 1024;

export async function hashPassword(password: string): Promise<string> {
  if (password.length < 10) {
    throw new Error('Password must be at least 10 characters.');
  }
  const salt = randomBytes(SALT_LENGTH);
  const derived = await scrypt(password.normalize('NFKC'), salt, KEY_LENGTH, {
    N: 16384,
    r: 8,
    p: 1,
    maxmem: MAX_MEMORY,
  } satisfies ScryptOptions);
  return `scrypt$16384$8$1$${salt.toString('base64')}$${derived.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4] as string, 'base64');
    expected = Buffer.from(parts[5] as string, 'base64');
  } catch {
    return false;
  }
  if (expected.length !== KEY_LENGTH) return false;

  const derived = await scrypt(password.normalize('NFKC'), salt, KEY_LENGTH, {
    N,
    r,
    p,
    maxmem: MAX_MEMORY,
  } satisfies ScryptOptions);
  // timingSafeEqual throws on length mismatch, so lengths are checked first.
  return timingSafeEqual(derived, expected);
}
