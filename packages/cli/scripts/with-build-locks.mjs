#!/usr/bin/env node
/**
 * Runs a command while holding wireit's own lock on every script a wireit script depends
 * on, transitively, so a concurrent wireit process cannot clean, rebuild, or cache-restore
 * those outputs while the command reads them.
 *
 * Usage: `node scripts/with-build-locks.mjs <script> <command> [args...]`, where `<script>` is
 * a wireit script in this package's `package.json`. Wireit holds
 * `<package>/.wireit/<hex script name>/lock` through proper-lockfile around a script's
 * fingerprint check, clean, cache restore, and run. This takes the same locks, in path order,
 * then runs the command, so another process's build of any of them waits until the command
 * exits. A run never waits on its own build, because wireit releases each lock before a
 * dependent script starts. Locks are released when the command exits or this process dies.
 * A SIGKILLed holder's locks go stale after 10 seconds, wireit's own window. Exits with the
 * command's exit code, or 1 when it was killed by a signal.
 */

import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

// wireit's own stale and update windows, so wireit reads a live holder as live.
const STALE_MS = 10_000;
const UPDATE_MS = 2_000;
const RETRY_MS = 200;
const FORWARDED_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];

// resolve() drops the URL's trailing slash, so this matches the dirs dependencies resolve to.
const PACKAGE_DIR = resolve(fileURLToPath(new URL('..', import.meta.url)));

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
  // Keyed by lock path: taking one lock twice would wait on this process forever.
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

async function acquire({ path, label }) {
  mkdirSync(dirname(path), { recursive: true });
  // proper-lockfile refuses a file that does not exist. Append mode creates it untouched.
  writeFileSync(path, '', { flag: 'a' });
  let hasAnnounced = false;
  for (;;) {
    try {
      return await lockfile.lock(path, {
        stale: STALE_MS,
        update: UPDATE_MS,
        onCompromised: (error) =>
          console.warn(`with-build-locks: lost the lock on ${label}: ${error}`),
      });
    } catch (error) {
      if (error.code !== 'ELOCKED') throw error;
      if (!hasAnnounced) {
        console.log(`with-build-locks: waiting for the lock on ${label}`);
        hasAnnounced = true;
      }
      await sleep(RETRY_MS);
    }
  }
}

async function releaseAll(releases) {
  await Promise.all(releases.map((release) => release().catch(() => {})));
}

const [scriptName, command, ...args] = process.argv.slice(2);
if (scriptName === undefined || command === undefined) {
  console.error(
    'usage: node scripts/with-build-locks.mjs <script> <command> [args...]',
  );
  process.exit(1);
}

const releases = [];
for (const lock of collectLocks(PACKAGE_DIR, scriptName)) {
  releases.push(await acquire(lock));
}

const child = spawn(command, args, { stdio: 'inherit' });
for (const signal of FORWARDED_SIGNALS) {
  process.on(signal, () => child.kill(signal));
}
child.on('error', async (error) => {
  console.error(`with-build-locks: could not start ${command}: ${error}`);
  await releaseAll(releases);
  process.exit(1);
});
child.on('exit', async (code) => {
  await releaseAll(releases);
  process.exit(code ?? 1);
});
