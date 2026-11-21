import { spawnSync } from 'node:child_process';
import {
  existsSync,
  renameSync,
  rmSync,
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const MARKER = '.bench-build.json';

/** Install from the lockfile, then build the workspace. Each entry is `[command, args]`. */
export const BUILD_STEPS = [
  ['pnpm', ['install', '--frozen-lockfile']],
  ['pnpm', ['build']],
];

/** Default build cache: `<os.tmpdir()>/houserules-bench/builds`. */
export function defaultCacheDir() {
  return join(tmpdir(), 'houserules-bench', 'builds');
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

/**
 * Look up a finished build of `rev` in `cacheDir` without building. Throws when `rev` names
 * no commit. Never runs a step, adds a worktree, or writes under `cacheDir`.
 *
 * @returns {{ commit: string, root: string } | null}
 */
export function findBuild(rev, { repoDir, cacheDir = defaultCacheDir() }) {
  const commit = resolveCommit(repoDir, rev);
  const root = join(cacheDir, commit);
  return existsSync(join(root, MARKER)) ? { commit, root } : null;
}

/**
 * Build `rev` of `repoDir` in a temporary git worktree and cache the built tree at
 * `<cacheDir>/<sha>`. A cache hit needs the completion marker and runs no step.
 * Throws an Error naming the failed step, with the cause attached, and leaves no worktree behind.
 *
 * @returns {{ commit: string, root: string, cached: boolean }}
 */
export function ensureBuild(
  rev,
  { repoDir, cacheDir = defaultCacheDir(), steps = BUILD_STEPS },
) {
  const found = findBuild(rev, { repoDir, cacheDir });
  if (found) return { ...found, cached: true };
  const commit = resolveCommit(repoDir, rev);
  const root = join(cacheDir, commit);
  if (existsSync(root)) rmSync(root, { recursive: true, force: true });

  const worktree = join(
    tmpdir(),
    'houserules-bench',
    `wt-${commit}-${process.pid}`,
  );
  mkdirSync(dirname(worktree), { recursive: true });
  git(repoDir, ['worktree', 'add', '--detach', worktree, commit]);

  const failure = runBuildSteps(worktree, steps);
  if (failure) {
    removeWorktree(repoDir, worktree);
    const why = describeStepFailure(failure.result);
    throw new Error(`build step "${failure.step}" failed (${why})`, {
      cause: failure.result.error ?? new Error(why),
    });
  }

  mkdirSync(cacheDir, { recursive: true });
  renameSync(worktree, root);
  git(repoDir, ['worktree', 'prune']);
  writeFileSync(
    join(root, MARKER),
    JSON.stringify({ commit, finishedAt: new Date().toISOString() }),
  );
  return { commit, root, cached: false };
}
