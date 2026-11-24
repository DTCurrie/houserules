import {
  closeSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { resolve } from 'node:path';

/** The lock a live push holds, so a burst of `SessionEnd` hooks drains the queue once. */
export function pushLockPath(root: string): string {
  return resolve(root, '.claude/state/projects-sync.lock');
}

/**
 * A lock older than this is taken over even when its pid is alive, which covers a recycled pid.
 * The bound comes from `.claude/state/projects-sync.log`. The slowest push it records ran from
 * 16:50:30 to 16:50:58 on 2026-11-22, about 28 seconds, so five minutes is over ten times that
 * and under the ten minute cap.
 */
export const PUSH_LOCK_STALE_MS = 5 * 60 * 1000;

interface PushLockOwner {
  pid: number;
  startedAt: number;
}

export function readLockOwner(lockFile: string): PushLockOwner | null {
  try {
    const parsed = JSON.parse(
      readFileSync(lockFile, 'utf8'),
    ) as Partial<PushLockOwner>;
    if (typeof parsed.pid === 'number' && typeof parsed.startedAt === 'number')
      return { pid: parsed.pid, startedAt: parsed.startedAt };
  } catch {
    // A missing or half written lock falls through to the file's own age.
  }
  return null;
}

export function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Whether the lock file can be taken over: its owner is dead or past the stale bound. A file
 * with no readable owner is judged by its own age, and a missing file is stale.
 */
export function pushLockIsStale(lockFile: string, now = Date.now()): boolean {
  const owner = readLockOwner(lockFile);
  if (owner)
    return !pidIsAlive(owner.pid) || now - owner.startedAt > PUSH_LOCK_STALE_MS;
  try {
    return now - statSync(lockFile).mtimeMs > PUSH_LOCK_STALE_MS;
  } catch {
    return true;
  }
}

/** Whether a live, fresh lock exists. */
export function pushLockIsHeld(lockFile: string): boolean {
  return !pushLockIsStale(lockFile);
}

function createLockExclusively(lockFile: string): boolean {
  let fd: number;
  try {
    fd = openSync(lockFile, 'wx');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
  try {
    const owner: PushLockOwner = { pid: process.pid, startedAt: Date.now() };
    writeFileSync(fd, JSON.stringify(owner));
  } finally {
    closeSync(fd);
  }
  return true;
}

/** A takeover guard older than this was left by a crashed run, since a takeover takes microseconds. */
const TAKEOVER_GUARD_STALE_MS = 30 * 1000;

function removeFile(file: string): void {
  try {
    unlinkSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

/**
 * Takes the lock file for this process. Returns false when a live, fresh lock is held, or when
 * another run is taking over or won the takeover of a stale one.
 *
 * A stale lock is removed only by the run holding `<lock>.takeover`, a guard created with `wx`.
 * That run checks staleness again under the guard, so it never removes a lock that replaced the
 * stale one. No other run removes the lock, and a run that finds the file missing can create it
 * only through `wx`, so two runs never both hold. A run that finds the guard taken returns false.
 * A guard older than {@link TAKEOVER_GUARD_STALE_MS} is removed and the run still returns false,
 * so the next run takes over.
 */
export function takePushLockFile(lockFile: string): boolean {
  if (createLockExclusively(lockFile)) return true;
  if (!pushLockIsStale(lockFile)) return false;

  const guard = `${lockFile}.takeover`;
  try {
    closeSync(openSync(guard, 'wx'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    try {
      if (Date.now() - statSync(guard).mtimeMs > TAKEOVER_GUARD_STALE_MS)
        removeFile(guard);
    } catch {
      // The guard vanished, so its holder finished.
    }
    return false;
  }
  try {
    if (!pushLockIsStale(lockFile)) return false;
    removeFile(lockFile);
    return createLockExclusively(lockFile);
  } finally {
    removeFile(guard);
  }
}
