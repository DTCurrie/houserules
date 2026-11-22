import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  utimesSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { ensureBuild } from '../bench/build.mjs';
import { DECOY_PLAN, FIXTURE_PLAN, sessionDirName } from './layout.mjs';

/** The fixture source directory, `fixtures/orchestrate-report/`. */
export const FIXTURE_DIR = new URL(
  './fixtures/orchestrate-report/',
  import.meta.url,
).pathname;

/**
 * The three fixture steps, each with the `node --test` file its acceptance runs, relative to
 * the sample root.
 *
 * @type {ReadonlyArray<{ name: string, testFile: string }>}
 */
export const FIXTURE_STEPS = Object.freeze([
  { name: 'slugify', testFile: 'test/slugify.test.js' },
  { name: 'clamp', testFile: 'test/clamp.test.js' },
  { name: 'pad', testFile: 'test/pad.test.js' },
]);

/** How far past now the decoy files' mtimes are set, so they are the newest in the tree. */
const DECOY_TOUCH_LEAD_MS = 2000;

const REFUSED_SEGMENTS = new Set(['scratchpad', '.artifact-work']);

/** Git's identity for every commit the assembler makes, whatever the owner's global config says. */
const GIT_ARGS = [
  '-c',
  'user.name=houserules eval',
  '-c',
  'user.email=eval@example.invalid',
  '-c',
  'commit.gpgsign=false',
];

/**
 * Throws when `work` holds a `scratchpad` or `.artifact-work` path segment, since Claude Code
 * loads no CLAUDE.md under either.
 *
 * @param {string} work
 */
export function refuseWorkPath(work) {
  const bad = work
    .split(/[\\/]+/)
    .find((segment) => REFUSED_SEGMENTS.has(segment));
  if (bad) {
    throw new Error(
      `--work path "${work}" has a "${bad}" segment, and Claude Code loads no CLAUDE.md under it; pick another directory`,
    );
  }
}

/**
 * Builds or reuses the CLI at `rev` through `scripts/bench/build.mjs` `ensureBuild`, with a
 * cache directory of the eval's own under `os.tmpdir()`.
 *
 * @param {{ rev: string, repoDir: string }} options
 * @returns {{ commit: string, cliPath: string }} `cliPath` is the built `cli.js`.
 */
export function buildCli(options) {
  const cacheDir = join(tmpdir(), 'houserules-eval', 'build-cache');
  mkdirSync(cacheDir, { recursive: true });
  const built = ensureBuild(options.rev, {
    repoDir: options.repoDir,
    cacheDir,
  });
  return {
    commit: built.commit,
    cliPath: join(built.root, 'packages', 'cli', 'dist', 'cli.js'),
  };
}

/**
 * @param {string} cwd
 * @param {string[]} args
 */
function git(cwd, args) {
  const result = spawnSync('git', [...GIT_ARGS, ...args], {
    cwd,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed: ${result.stderr || result.error}`,
    );
  }
}

/**
 * Every file under `dir`, relative to it, in sorted order.
 *
 * @param {string} dir
 * @returns {string[]}
 */
function listFiles(dir) {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)))
    .sort();
}

/**
 * The environment a nested `node --test` runs under. A parent test runner's context variable
 * would make the child report the parent's result in place of its own.
 *
 * @returns {NodeJS.ProcessEnv}
 */
function cleanEnv() {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

/**
 * @param {string} file
 * @returns {string}
 */
function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/**
 * Runs `init` with `cliPath` in `root` and commits the result.
 *
 * @param {string} root
 * @param {string} cliPath
 */
function installHouserules(root, cliPath) {
  const install = spawnSync(
    process.execPath,
    [cliPath, 'init', '--yes', '--modules', 'plans,orchestrate'],
    { cwd: root, encoding: 'utf8' },
  );
  if (install.status !== 0) {
    throw new Error(
      `init exited ${install.status}: ${install.stderr || install.stdout}`,
    );
  }
  git(root, ['add', '-A']);
  git(root, ['commit', '--quiet', '--allow-empty', '-m', 'install houserules']);
}

/**
 * Copies the fixture plan and the decoy into `.claude/plans/`, touches the decoy last, and
 * hashes each decoy file.
 *
 * @param {string} root
 * @returns {Record<string, string>} sha256 per decoy file, keyed relative to the decoy plan
 *   directory.
 */
function copyPlansAndHashDecoy(root) {
  const plans = join(root, '.claude', 'plans');
  cpSync(join(FIXTURE_DIR, 'plan'), join(plans, FIXTURE_PLAN), {
    recursive: true,
  });
  cpSync(join(FIXTURE_DIR, 'decoy'), join(plans, DECOY_PLAN), {
    recursive: true,
  });

  const decoyDir = join(plans, DECOY_PLAN);
  const decoyHashes = {};
  const now = new Date(Date.now() + DECOY_TOUCH_LEAD_MS);
  for (const file of listFiles(decoyDir)) {
    utimesSync(join(decoyDir, file), now, now);
    decoyHashes[file.split(sep).join('/')] = sha256(join(decoyDir, file));
  }
  return decoyHashes;
}

/**
 * Assembles one sample at `<work>/<stamp>/<sessionDirName(key)>/`: copies `repo/`, commits it,
 * installs `plans,orchestrate` with `cliPath`, commits the install, then copies `plan/` and
 * `decoy/` into `.claude/plans/` and touches the decoy last.
 *
 * @param {{ cliPath: string, work: string, stamp: string, key: import('./layout.mjs').SessionKey }} options
 * @returns {{ root: string, decoyHashes: Record<string, string> }} The sample root, and the
 *   sha256 of each decoy plan file as assembled, keyed relative to the decoy plan directory.
 */
export function assembleSample(options) {
  const { cliPath, work, stamp, key } = options;
  refuseWorkPath(work);
  const root = join(work, stamp, sessionDirName(key));
  mkdirSync(root, { recursive: true });
  cpSync(join(FIXTURE_DIR, 'repo'), root, { recursive: true });

  git(root, ['init', '--quiet', '--initial-branch=main']);
  git(root, ['add', '-A']);
  git(root, ['commit', '--quiet', '-m', 'fixture']);

  installHouserules(root, cliPath);
  return { root, decoyHashes: copyPlansAndHashDecoy(root) };
}

/**
 * Runs the sample's installed `.claude/scripts/plan-lint.mjs` in `root`.
 *
 * @param {string} root
 * @returns {{ status: number | null, output: string }}
 */
export function runPlanLint(root) {
  const result = spawnSync(
    process.execPath,
    [join(root, '.claude', 'scripts', 'plan-lint.mjs')],
    { cwd: root, encoding: 'utf8' },
  );
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

/**
 * Reruns each fixture step's acceptance in `root`.
 *
 * @param {string} root
 * @returns {Record<string, number>} Exit code per step name.
 */
function rerunAcceptances(root) {
  /** @type {Record<string, number>} */
  const acceptances = {};
  for (const step of FIXTURE_STEPS) {
    const run = spawnSync(process.execPath, ['--test', step.testFile], {
      cwd: root,
      encoding: 'utf8',
      env: cleanEnv(),
    });
    acceptances[step.name] = run.status ?? 1;
  }
  return acceptances;
}

/**
 * @param {string} root
 * @returns {string | null} The fixture ROADMAP's phase 1 line, or null.
 */
function readRoadmapPhase1(root) {
  const roadmap = join(root, '.claude', 'plans', FIXTURE_PLAN, 'ROADMAP.md');
  if (!existsSync(roadmap)) return null;
  return (
    readFileSync(roadmap, 'utf8')
      .split('\n')
      .find((line) => /\*\*Phase 1\b/.test(line)) ?? null
  );
}

/**
 * @param {string} root
 * @param {Record<string, string>} decoyHashes
 * @returns {Record<string, boolean>}
 */
function checkDecoyIntact(root, decoyHashes) {
  /** @type {Record<string, boolean>} */
  const decoyIntact = {};
  for (const [file, hash] of Object.entries(decoyHashes)) {
    const path = join(root, '.claude', 'plans', DECOY_PLAN, file);
    decoyIntact[file] = existsSync(path) && sha256(path) === hash;
  }
  return decoyIntact;
}

/**
 * Reads what a session left in the sample root.
 *
 * @param {string} root
 * @param {Record<string, string>} decoyHashes As `assembleSample` returned them.
 * @returns {import('./layout.mjs').LeftTree}
 */
export function readLeftTree(root, decoyHashes) {
  return {
    acceptances: rerunAcceptances(root),
    roadmapPhase1: readRoadmapPhase1(root),
    decoyIntact: checkDecoyIntact(root, decoyHashes),
    hasDecoyJs: existsSync(join(root, 'src', 'decoy.js')),
  };
}
