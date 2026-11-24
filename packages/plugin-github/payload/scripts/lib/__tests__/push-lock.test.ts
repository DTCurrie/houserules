import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

import {
  PUSH_LOCK_STALE_MS,
  pidIsAlive,
  pushLockIsHeld,
  pushLockIsStale,
  pushLockPath,
  readLockOwner,
  takePushLockFile,
} from '../push-lock.mjs';

const LIB_URL = pathToFileURL(
  join(import.meta.dirname, '..', 'push-lock.mts'),
).href;
const DEAD_PID = 2 ** 22 + 12345;
const RACERS = 4;
const ROUNDS = 40;
const START_DELAY_MS = 2500;
const POLL_MS = 20;

const RACER_SOURCE = `
import { takePushLockFile } from ${JSON.stringify(LIB_URL)};
import { existsSync } from 'node:fs';
const [lockFile, startAt, releaseFile] = process.argv.slice(2);
while (Date.now() < Number(startAt)) {}
const won = takePushLockFile(lockFile);
console.log(won ? 'won' : 'lost');
while (!existsSync(releaseFile)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${POLL_MS});
`;

function writeOwner(lockFile: string, pid: number, startedAt: number): void {
  writeFileSync(lockFile, JSON.stringify({ pid, startedAt }));
}

function race(
  scriptFile: string,
  lockFile: string,
  startAt: number,
  releaseFile: string,
  onResult: () => void,
): Promise<string[]> {
  const racers = Array.from(
    { length: RACERS },
    () =>
      new Promise<string>((done) => {
        const child = spawn(
          process.execPath,
          [scriptFile, lockFile, String(startAt), releaseFile],
          { stdio: ['ignore', 'pipe', 'inherit'] },
        );
        let out = '';
        child.stdout.on('data', (chunk) => {
          out += chunk;
          onResult();
        });
        child.on('close', () => done(out.trim()));
      }),
  );
  return Promise.all(racers);
}

describe('push lock', () => {
  let dir: string;
  let lockFile: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'push-lock-'));
    lockFile = join(dir, 'projects-sync.lock');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('keeps the lock under .claude/state of the given root', () => {
    expect(pushLockPath('/repo')).toBe(
      '/repo/.claude/state/projects-sync.lock',
    );
  });

  it('treats a lock as stale after exactly five minutes', () => {
    expect(PUSH_LOCK_STALE_MS).toBe(300000);
  });

  describe('pushLockIsStale', () => {
    it('is false for a live owner started just now', () => {
      writeOwner(lockFile, process.pid, 1_000_000);

      expect(pushLockIsStale(lockFile, 1_000_000 + 299_999)).toBe(false);
    });

    it('is true for a live owner started over five minutes ago', () => {
      writeOwner(lockFile, process.pid, 1_000_000);

      expect(pushLockIsStale(lockFile, 1_000_000 + 300_001)).toBe(true);
    });

    it('is true for a fresh lock whose owner pid is dead', () => {
      writeOwner(lockFile, DEAD_PID, Date.now());

      expect(pushLockIsStale(lockFile)).toBe(true);
    });

    it('judges an unreadable lock by its file age, so a new one is not stale', () => {
      writeFileSync(lockFile, 'half writ');

      expect(pushLockIsStale(lockFile)).toBe(false);
    });

    it('is true when the file is missing', () => {
      expect(pushLockIsStale(lockFile)).toBe(true);
    });
  });

  describe('pidIsAlive', () => {
    it('is true for this process', () => {
      expect(pidIsAlive(process.pid)).toBe(true);
    });

    it('is false for a pid no process holds', () => {
      expect(pidIsAlive(DEAD_PID)).toBe(false);
    });
  });

  describe('readLockOwner', () => {
    it('returns the pid and start time written', () => {
      writeOwner(lockFile, 42, 7);

      expect(readLockOwner(lockFile)).toEqual({ pid: 42, startedAt: 7 });
    });

    it('returns null for a half written lock', () => {
      writeFileSync(lockFile, '{"pid":');

      expect(readLockOwner(lockFile)).toBeNull();
    });
  });

  describe('pushLockIsHeld', () => {
    it('is false when no lock exists', () => {
      expect(pushLockIsHeld(lockFile)).toBe(false);
    });

    it('is true for a lock this process holds', () => {
      writeOwner(lockFile, process.pid, Date.now());

      expect(pushLockIsHeld(lockFile)).toBe(true);
    });

    it('is false for a lock whose owner is dead', () => {
      writeOwner(lockFile, DEAD_PID, Date.now());

      expect(pushLockIsHeld(lockFile)).toBe(false);
    });
  });

  describe('takePushLockFile', () => {
    it('creates the lock when none exists', () => {
      expect(takePushLockFile(lockFile)).toBe(true);
      expect(readLockOwner(lockFile)?.pid).toBe(process.pid);
    });

    it('refuses a lock held by a live, fresh owner and leaves it in place', () => {
      writeOwner(lockFile, process.pid, Date.now());

      expect(takePushLockFile(lockFile)).toBe(false);
      expect(readLockOwner(lockFile)?.pid).toBe(process.pid);
    });

    it('takes over a stale lock and leaves no takeover guard behind', () => {
      writeOwner(lockFile, DEAD_PID, 0);

      expect(takePushLockFile(lockFile)).toBe(true);
      expect(readdirSync(dir)).toEqual(['projects-sync.lock']);
    });

    it('lets exactly one of several concurrent runs take over one stale lock', async () => {
      const scriptFile = join(dir, 'racer.mjs');
      writeFileSync(scriptFile, RACER_SOURCE);
      const startAt = Date.now() + START_DELAY_MS;
      const lockFiles = Array.from({ length: ROUNDS }, (_, round) => {
        const roundLock = join(dir, `round-${round}.lock`);
        writeOwner(roundLock, DEAD_PID, 0);
        return roundLock;
      });

      const releaseFile = join(dir, 'release');
      let reported = 0;
      const onResult = () => {
        reported += 1;
        if (reported === ROUNDS * RACERS) writeFileSync(releaseFile, '');
      };

      const rounds = await Promise.all(
        lockFiles.map((roundLock) =>
          race(scriptFile, roundLock, startAt, releaseFile, onResult),
        ),
      );

      const failures = rounds
        .map((results, round) => ({ round, results }))
        .filter(
          ({ results }) =>
            results.filter((result) => result === 'won').length !== 1,
        )
        .map(({ round, results }) => `round ${round}: ${results.join(',')}`);
      expect(failures, 'rounds without exactly one winner').toEqual([]);
      expect(lockFiles.every((roundLock) => existsSync(roundLock))).toBe(true);
    }, 60_000);
  });
});
