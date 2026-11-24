#!/usr/bin/env node
/**
 * Runs a command while holding wireit's own lock on every script a wireit script depends
 * on, transitively, as a shared reader. Any number of wrapped commands that read one upstream
 * run at once, and a concurrent wireit process cannot clean, rebuild, or cache-restore that
 * upstream until the last of them exits.
 *
 * Usage: `node ../../scripts/with-build-locks.mjs <script> <command> [args...]`, run from a
 * package directory, where `<script>` is a wireit script in that package's `package.json`.
 * Chain several commands as one with `sh -c '<a> && <b>'`.
 *
 * Wireit holds `<package>/.wireit/<hex script name>/lock` through proper-lockfile: an atomic
 * `mkdir` of `<realpath>.lock`, which reads as held while its mtime is under 10 seconds old.
 * The first reader takes that directory as wireit would. Every reader registers a file named
 * by its pid in the sibling `lock.readers/` and refreshes the directory's mtime, then its own
 * file's, every 2 seconds. A reader joins the group or leaves it under a short proper-lockfile
 * mutex on `lock.mutex`, and the last live reader out removes the directory. A reader whose
 * process is gone, or whose file is over 5 seconds old, is not counted. When the lock is held
 * and no live reader is registered, wireit holds it, and the reader waits.
 *
 * Locks are taken in path order, so two holders never deadlock. A run never waits on its own
 * build, because wireit releases each lock before a dependent script starts. A SIGKILLed
 * reader's hold goes stale within 10 seconds, wireit's own window. Exits with the command's
 * exit code, or 1 when it was killed by a signal or could not start.
 */

import { spawn } from 'node:child_process';
import {
  mkdirSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  statSync,
  unlinkSync,
  utimesSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

// wireit's own stale and update windows, so wireit reads a live group as live.
const STALE_MS = 10_000;
const UPDATE_MS = 2_000;
// A reader file older than this is dead. Half the stale window leaves the lock fresh past it.
const LIVE_MS = STALE_MS / 2;
const RETRY_MS = 200;
const MUTEX_RETRY_MS = 25;
const FORWARDED_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];

// wireit runs each command in its package directory.
const PACKAGE_DIR = resolve(process.cwd());

// Resolved through wireit rather than declared here: both sides must speak one lock protocol.
const require = createRequire(import.meta.url);
const lockfile = createRequire(require.resolve('wireit/package.json'))(
  'proper-lockfile',
);

const wireitConfigs = new Map();

function readWireitConfig(packageDir) {
  if (!wireitConfigs.has(packageDir)) {
    const manifest = JSON.parse(
      readFileSync(join(packageDir, 'package.json'), 'utf8'),
    );
    wireitConfigs.set(packageDir, manifest.wireit ?? {});
  }
  return wireitConfigs.get(packageDir);
}

/**
 * Resolves a wireit dependency entry, `build:ts` or `../cli:build:ts` or the object form, to
 * the package directory and script name it names.
 */
function parseDependency(packageDir, dependency) {
  const spec = typeof dependency === 'string' ? dependency : dependency.script;
  if (!spec.startsWith('.')) return { packageDir, name: spec };
  const colon = spec.indexOf(':');
  return {
    packageDir: resolve(packageDir, spec.slice(0, colon)),
    name: spec.slice(colon + 1),
  };
}

/** Mirrors wireit: a script with a command is locked unless its `output` is an explicit `[]`. */
function isWireitLocked(config) {
  if (config.command === undefined) return false;
  return !(Array.isArray(config.output) && config.output.length === 0);
}

/**
 * Walks `name`'s dependencies transitively and returns the lock path and a label for each
 * one wireit locks, sorted by path so every holder acquires them in the same order.
 */
function collectLocks(packageDir, name) {
  const visited = new Map();
  const pending = [{ packageDir, name }];
  while (pending.length > 0) {
    const current = pending.pop();
    const config = readWireitConfig(current.packageDir)[current.name];
    if (config === undefined) {
      throw new Error(
        `no wireit script "${current.name}" in ${current.packageDir}`,
      );
    }
    for (const dependency of config.dependencies ?? []) {
      const target = parseDependency(current.packageDir, dependency);
      const key = `${target.packageDir}\0${target.name}`;
      if (visited.has(key)) continue;
      visited.set(key, target);
      pending.push(target);
    }
  }
  // Keyed by lock path: one process registers once per lock.
  const locks = new Map();
  for (const target of visited.values()) {
    if (!isWireitLocked(readWireitConfig(target.packageDir)[target.name])) {
      continue;
    }
    const path = join(
      target.packageDir,
      '.wireit',
      Buffer.from(target.name).toString('hex'),
      'lock',
    );
    locks.set(path, { path, label: `${target.packageDir}:${target.name}` });
  }
  return [...locks.values()].sort((left, right) =>
    left.path.localeCompare(right.path),
  );
}

function ignoreMissing(action) {
  try {
    action();
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function setMtime(path, time) {
  const date = new Date(time);
  utimesSync(path, date, date);
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

/** Creates the lock's files and resolves the paths proper-lockfile itself would use. */
function prepare(lock) {
  mkdirSync(dirname(lock.path), { recursive: true });
  // proper-lockfile refuses a file that does not exist. Append mode creates it untouched.
  writeFileSync(lock.path, '', { flag: 'a' });
  const realPath = realpathSync(lock.path);
  lock.lockDir = `${realPath}.lock`;
  lock.readersDir = join(dirname(realPath), 'lock.readers');
  lock.mutexPath = join(dirname(realPath), 'lock.mutex');
  lock.entryPath = join(lock.readersDir, String(process.pid));
  mkdirSync(lock.readersDir, { recursive: true });
  writeFileSync(lock.mutexPath, '', { flag: 'a' });
}

async function withMutex(lock, action) {
  for (;;) {
    let release;
    try {
      release = await lockfile.lock(lock.mutexPath, {
        stale: STALE_MS,
        update: UPDATE_MS,
        onCompromised: (error) =>
          console.warn(
            `with-build-locks: lost the reader mutex on ${lock.label}: ${error}`,
          ),
      });
    } catch (error) {
      if (error.code !== 'ELOCKED') throw error;
      await sleep(MUTEX_RETRY_MS);
      continue;
    }
    try {
      return action();
    } finally {
      await release().catch(() => {});
    }
  }
}

/** Counts the other live readers of `lock`, deleting the files of dead ones. Mutex held. */
function countLiveReaders(lock, now) {
  let count = 0;
  for (const name of readdirSync(lock.readersDir)) {
    const entryPath = join(lock.readersDir, name);
    if (entryPath === lock.entryPath) continue;
    let mtime;
    try {
      mtime = statSync(entryPath).mtimeMs;
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    if (isProcessAlive(Number(name)) && mtime >= now - LIVE_MS) {
      count += 1;
    } else {
      ignoreMissing(() => unlinkSync(entryPath));
    }
  }
  return count;
}

/** Takes the lock directory the way proper-lockfile does, replacing a stale one. */
function takeLockDir(lockDir, now) {
  for (;;) {
    try {
      mkdirSync(lockDir);
      return true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    let mtime;
    try {
      mtime = statSync(lockDir).mtimeMs;
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    if (mtime >= now - STALE_MS) return false;
    ignoreMissing(() => rmdirSync(lockDir));
  }
}

/**
 * Joins the reader group holding `lock`, or takes the lock for a new group. Returns false
 * when wireit holds it. Mutex held. The lock directory's mtime is set before the reader
 * file's, so a live reader file always vouches for a fresh lock.
 */
function tryJoin(lock) {
  const now = Date.now();
  ignoreMissing(() => unlinkSync(lock.entryPath));
  if (countLiveReaders(lock, now) === 0 && !takeLockDir(lock.lockDir, now)) {
    return false;
  }
  setMtime(lock.lockDir, now);
  writeFileSync(lock.entryPath, '');
  setMtime(lock.entryPath, now);
  lock.lastRefresh = now;
  return true;
}

async function joinGroup(lock) {
  let hasAnnounced = false;
  while (!(await withMutex(lock, () => tryJoin(lock)))) {
    if (!hasAnnounced) {
      console.log(`with-build-locks: waiting for the lock on ${lock.label}`);
      hasAnnounced = true;
    }
    await sleep(RETRY_MS);
  }
}

/**
 * Keeps the hold fresh. A reader that stalled past the live window can no longer vouch for
 * the lock on its own, since wireit may have taken it, so it rejoins under the mutex.
 */
async function refresh(lock) {
  const now = Date.now();
  let isHeld = now - lock.lastRefresh < LIVE_MS;
  if (isHeld) {
    try {
      setMtime(lock.lockDir, now);
      setMtime(lock.entryPath, now);
      lock.lastRefresh = now;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      isHeld = false;
    }
  }
  if (!isHeld) {
    console.warn(`with-build-locks: rejoining the lock on ${lock.label}`);
    await joinGroup(lock);
  }
}

function scheduleRefresh(lock) {
  lock.timer = setTimeout(() => {
    lock.pendingRefresh = refresh(lock)
      .catch((error) =>
        console.warn(
          `with-build-locks: could not refresh the lock on ${lock.label}: ${error}`,
        ),
      )
      .finally(() => {
        if (!lock.isReleasing) scheduleRefresh(lock);
      });
  }, UPDATE_MS);
}

async function acquire(lock) {
  prepare(lock);
  await joinGroup(lock);
  scheduleRefresh(lock);
  return lock;
}

/** Leaves the group. The last live reader out removes the lock directory. */
async function release(lock) {
  lock.isReleasing = true;
  clearTimeout(lock.timer);
  await lock.pendingRefresh;
  await withMutex(lock, () => {
    const now = Date.now();
    ignoreMissing(() => unlinkSync(lock.entryPath));
    // A reader that stalled past the live window may no longer own the directory.
    const isOwnHoldFresh = now - lock.lastRefresh < LIVE_MS;
    if (countLiveReaders(lock, now) === 0 && isOwnHoldFresh) {
      ignoreMissing(() => rmdirSync(lock.lockDir));
    }
  });
}

let isFinishing = false;

async function finish(heldLocks, exitCode) {
  if (isFinishing) return;
  isFinishing = true;
  await Promise.all(heldLocks.map((lock) => release(lock).catch(() => {})));
  process.exit(exitCode);
}

const [scriptName, command, ...args] = process.argv.slice(2);
if (scriptName === undefined || command === undefined) {
  console.error(
    'usage: node ../../scripts/with-build-locks.mjs <script> <command> [args...]',
  );
  process.exit(1);
}

const heldLocks = [];
for (const lock of collectLocks(PACKAGE_DIR, scriptName)) {
  heldLocks.push(await acquire(lock));
}

const child = spawn(command, args, { stdio: 'inherit' });
for (const signal of FORWARDED_SIGNALS) {
  process.on(signal, () => child.kill(signal));
}
child.on('error', (error) => {
  console.error(`with-build-locks: could not start ${command}: ${error}`);
  void finish(heldLocks, 1);
});
child.on('exit', (code) => {
  void finish(heldLocks, code ?? 1);
});
