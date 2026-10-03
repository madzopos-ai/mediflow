/**
 * Single-instance guard for the gateway.
 *
 * Two gateway processes fighting over the same Baileys session directory is
 * the fastest way to get `Connection Closed` followed by a forced `logged
 * out`: WhatsApp allows exactly one active socket per linked device, so the
 * second process kicks the first, the first reconnects and kicks the second,
 * and within seconds the server parks the session for 10 minutes.
 *
 * The scheduled-task runner (`run-gateway.bat`) already loops, so a second
 * copy is never needed for reliability - it is always a mistake (a manual
 * start next to the task, or two tasks after a setup rerun). This lock makes
 * that mistake loud instead of a mysterious pairing failure.
 *
 * The lock lives next to the working directory (`<cwd>/.gateway.lock`), which
 * is stable because the runner always `cd`s to the gateway folder first. It
 * holds `{"pid":N,"startedAt":"..."}`. A lock whose PID is dead is stale
 * (crash without cleanup) and is safely overwritten.
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const LOCK_FILENAME = '.gateway.lock';

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // ESRCH = no such process (stale lock). EPERM = alive but not ours.
    if (error instanceof Error && 'code' in error && (error as { code?: string }).code === 'ESRCH') {
      return false;
    }
    return true;
  }
}

function readLock(path: string): { pid: number } | null {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { pid?: unknown };
    if (typeof raw.pid === 'number' && Number.isInteger(raw.pid) && raw.pid > 0) {
      return { pid: raw.pid };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Throws when another live gateway holds the lock. Otherwise writes our PID
 * and returns a release function for graceful shutdown.
 */
export function acquireSingleInstanceLock(cwd: string = process.cwd()): () => void {
  const path = resolve(cwd, LOCK_FILENAME);
  if (existsSync(path)) {
    const lock = readLock(path);
    if (lock && lock.pid !== process.pid && pidAlive(lock.pid)) {
      throw new Error(
        `Another gateway is already running (PID ${lock.pid}, lock ${path}). ` +
          `Stop it first (schtasks /End /TN MediFlowGateway) instead of starting a second one - ` +
          `two processes over the same session directory force WhatsApp to log the device out.`,
      );
    }
    // Stale or unreadable lock: fall through and overwrite.
  }
  writeFileSync(path, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), 'utf8');
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    try {
      const current = readLock(path);
      // Only remove our own lock, never another process's.
      if (current && current.pid === process.pid) rmSync(path, { force: true });
    } catch {
      // Best effort on shutdown; a stale file is reclaimed on next boot.
    }
  };
  process.once('exit', release);
  process.once('SIGINT', () => {
    release();
    process.exit(0);
  });
  process.once('SIGTERM', () => {
    release();
    process.exit(0);
  });
  return release;
}
