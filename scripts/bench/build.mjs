import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

const MARKER = '.bench-build.json';
const WORKTREES = '.worktrees';
const LOCK_SUFFIX = '.lock';
const LOCK_OWNER = 'pid';
const LOCK_POLL_MS = 1000;

/**
 * Install from the lockfile, build the workspace, then run the build's own dogfood, so the
 * build carries the `.claude/settings.json` and `.claude/scripts/hook-wiring.json` its own
 * installer writes. Each entry is `[command, args]`.
 */
export const BUILD_STEPS = [
  ['pnpm', ['install', '--frozen-lockfile']],
  ['pnpm', ['build']],
  ['pnpm', ['dogfood']],
];

/**
 * Default build cache: `<repoDir>/node_modules/.cache/houserules-bench/builds`. It sits inside
 * the repository, already gitignored, so a wireit script can declare the build markers as inputs.
 */
export function defaultCacheDir(repoDir) {
  return join(repoDir, 'node_modules', '.cache', 'houserules-bench', 'builds');
}

function tryGit(repoDir, args) {
  return spawnSync('git', ['-C', repoDir, ...args], { encoding: 'utf8' });
}

function git(repoDir, args) {
  const result = tryGit(repoDir, args);
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed: ${result.stderr || result.error?.message}`,
    );
  }
  return result;
}

function removeWorktree(repoDir, worktree) {
  const removed = tryGit(repoDir, ['worktree', 'remove', '--force', worktree]);
  if (removed.status !== 0) {
    rmSync(worktree, { recursive: true, force: true });
    tryGit(repoDir, ['worktree', 'prune']);
  }
}

function describeStepFailure(result) {
  if (result.error) return result.error.message;
  if (result.signal) return `signal ${result.signal}`;
  return `exit ${result.status}`;
}

/** Runs each step in `worktree`. Returns the first failure as `{ step, result }`, or null. */
function runBuildSteps(worktree, steps) {
  for (const [command, args] of steps) {
    const result = spawnSync(command, args, {
      cwd: worktree,
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    if (result.status !== 0) {
      return { step: [command, ...args].join(' '), result };
    }
  }
  return null;
}

function resolveCommit(repoDir, rev) {
  return git(repoDir, [
    'rev-parse',
    '--verify',
    `${rev}^{commit}`,
  ]).stdout.trim();
}

function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

/** True when the lock names a holder that has exited. A lock with no owner file yet is live. */
function isLockAbandoned(lockDir) {
  const ownerFile = join(lockDir, LOCK_OWNER);
  if (!existsSync(ownerFile)) return false;
  const pid = Number(readFileSync(ownerFile, 'utf8'));
  return Number.isInteger(pid) && !isProcessAlive(pid);
}

/** Blocks until this process holds `lockDir`. A lock whose holder has exited is taken over. */
function acquireLock(lockDir) {
  for (;;) {
    try {
      mkdirSync(lockDir);
      writeFileSync(join(lockDir, LOCK_OWNER), String(process.pid));
      return;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    if (isLockAbandoned(lockDir))
      rmSync(lockDir, { recursive: true, force: true });
    else sleep(LOCK_POLL_MS);
  }
}

/**
 * Look up a finished build of `rev` in `cacheDir` without building. Throws when `rev` names
 * no commit. Never runs a step, adds a worktree, or writes under `cacheDir`.
 *
 * @returns {{ commit: string, root: string } | null}
 */
export function findBuild(
  rev,
  { repoDir, cacheDir = defaultCacheDir(repoDir) },
) {
  const commit = resolveCommit(repoDir, rev);
  const root = join(cacheDir, commit);
  return existsSync(join(root, MARKER)) ? { commit, root } : null;
}

function readMarker(root) {
  try {
    return JSON.parse(readFileSync(join(root, MARKER), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * The finished build in `cacheDir` whose marker records the latest `finishedAt`, or null when
 * none has finished. Reads only the markers, so the choice is a function of the files a wireit
 * script can declare as inputs. Never builds or writes.
 *
 * @returns {{ commit: string, root: string } | null}
 */
export function findNewestBuild({ cacheDir }) {
  if (!existsSync(cacheDir)) return null;
  const finished = readdirSync(cacheDir)
    .map((name) => ({ name, marker: readMarker(join(cacheDir, name)) }))
    .filter(({ marker }) => marker !== null)
    .sort((left, right) =>
      right.marker.finishedAt.localeCompare(left.marker.finishedAt),
    );
  if (finished.length === 0) return null;
  const [{ name, marker }] = finished;
  return { commit: marker.commit, root: join(cacheDir, name) };
}

function buildUnlocked({ repoDir, cacheDir, steps, commit }) {
  const root = join(cacheDir, commit);
  if (existsSync(root)) rmSync(root, { recursive: true, force: true });

  // Under the cache dir, not the OS temp dir, so the rename below never crosses a filesystem.
  const worktree = join(cacheDir, WORKTREES, `wt-${commit}-${process.pid}`);
  mkdirSync(join(cacheDir, WORKTREES), { recursive: true });
  git(repoDir, ['worktree', 'add', '--detach', worktree, commit]);

  const failure = runBuildSteps(worktree, steps);
  if (failure) {
    removeWorktree(repoDir, worktree);
    const why = describeStepFailure(failure.result);
    throw new Error(`build step "${failure.step}" failed (${why})`, {
      cause: failure.result.error ?? new Error(why),
    });
  }

  renameSync(worktree, root);
  git(repoDir, ['worktree', 'prune']);
  writeFileSync(
    join(root, MARKER),
    JSON.stringify({ commit, finishedAt: new Date().toISOString() }),
  );
}

/**
 * Build `rev` of `repoDir` in a git worktree under `cacheDir` and keep the built tree at
 * `<cacheDir>/<sha>`. A cache hit needs the completion marker and runs no step. Concurrent
 * callers for one sha share a lock, so one builds and the rest wait and reuse its build.
 * Throws an Error naming the failed step, with the cause attached, and leaves no worktree behind.
 *
 * @returns {{ commit: string, root: string, cached: boolean }}
 */
export function ensureBuild(
  rev,
  { repoDir, cacheDir = defaultCacheDir(repoDir), steps = BUILD_STEPS },
) {
  const found = findBuild(rev, { repoDir, cacheDir });
  if (found) return { ...found, cached: true };
  const commit = resolveCommit(repoDir, rev);
  mkdirSync(cacheDir, { recursive: true });
  const lockDir = join(cacheDir, `${commit}${LOCK_SUFFIX}`);
  acquireLock(lockDir);
  try {
    const builtMeanwhile = findBuild(commit, { repoDir, cacheDir });
    if (builtMeanwhile) return { ...builtMeanwhile, cached: true };
    buildUnlocked({ repoDir, cacheDir, steps, commit });
    return { commit, root: join(cacheDir, commit), cached: false };
  } finally {
    rmSync(lockDir, { recursive: true, force: true });
  }
}

/**
 * The build the bench tests run against: the newest finished build in `cacheDir`, or, when none
 * has finished, a fresh build of `rev`. Never returns null, so a missing build is a build or a
 * thrown step failure, never a skipped test.
 *
 * @returns {{ commit: string, root: string }}
 */
export function ensureNewestBuild(
  rev,
  { repoDir, cacheDir = defaultCacheDir(repoDir), steps = BUILD_STEPS },
) {
  const newest = findNewestBuild({ cacheDir });
  if (newest) return newest;
  const { commit, root } = ensureBuild(rev, { repoDir, cacheDir, steps });
  return { commit, root };
}
