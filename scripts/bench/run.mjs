#!/usr/bin/env node
/**
 * Measure how long houserules' code takes to run, on a build of a named commit.
 *
 * Command:
 *   node scripts/bench/run.mjs --suite <hooks|cli|scripts|all> --out <file>
 *     [--commit <rev>] [--smoke] [--runs <n>] [--warmup <n>]
 *   node scripts/bench/run.mjs --profile <suite/case> [--out <file>] [--commit <rev>]
 *     [--runs <n>] [--top <n>] [--interval <us>]
 *
 * Options:
 *   --suite   One suite name, or `all` (default `all`).
 *   --out     Path of the JSON result. Required.
 *   --commit  Revision to build and measure (default `HEAD`).
 *   --smoke   1 warmup run and 3 timed runs per case.
 *   --runs    Timed runs per case (default 20).
 *   --warmup  Untimed runs per case (default 3).
 *   --profile Profile one case id instead of timing, and print the top frames as JSON.
 *             `--out` becomes optional, `--runs` defaults to 5.
 *   --top     Frames to print under `--profile` (default 20).
 *   --interval  Profiler sampling interval in microseconds under `--profile` (default 100).
 *
 * Exit codes:
 *   0  every case ran and no case has the gate verdict `fail`.
 *   1  every case ran and at least one case has the gate verdict `fail`. The JSON is written.
 *   2  setup error: bad flags, a failed build, a fixture error, or a case that exited outside its
 *      `expectExit`. The message goes to stderr and no JSON is written.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { ensureBuild } from './build.mjs';
import { machineFacts } from './machine.mjs';
import { GATE, gateVerdict, summarize } from './stats.mjs';
import { profileCase } from './profile.mjs';
import { SUITES } from './suites/index.mjs';
import { measureCase } from './timing.mjs';

const SCHEMA_VERSION = 1;
const ALL_SUITES = 'all';
const DEFAULT_COMMIT = 'HEAD';
const DEFAULT_RUNS = 20;
const DEFAULT_WARMUP = 3;
const PROFILE_RUNS = 5;
const PROFILE_TOP = 20;
const PROFILE_INTERVAL_MICROSECONDS = 100;
const SMOKE_RUNS = 3;
const SMOKE_WARMUP = 1;
const EXIT_OK = 0;
const EXIT_GATE_FAIL = 1;
const EXIT_SETUP_ERROR = 2;
const MODE = Object.freeze({ smoke: 'smoke', full: 'full' });
const VERDICT = Object.freeze({ fail: 'fail', pass: 'pass' });
const WORK_DIR_PREFIX = 'houserules-bench-work-';
const REPO_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const REAL_DEPS = {
  ensureBuild,
  SUITES,
  measureCase,
  machineFacts,
  profileCase,
};

/** A flag value that cannot be used. Reported as a setup error. */
class UsageError extends Error {}

function parseCount(text, flag, minimum) {
  const count = Number(text);
  if (!Number.isInteger(count) || count < minimum) {
    throw new UsageError(
      `${flag} must be an integer of at least ${minimum}, got "${text}"`,
    );
  }
  return count;
}

function countOrDefault(text, flag, fallback) {
  return text === undefined ? fallback : parseCount(text, flag, 1);
}

function resolveCount({
  text,
  flag,
  minimum,
  smokeDefault,
  fullDefault,
  isSmoke,
}) {
  if (text !== undefined) return parseCount(text, flag, minimum);
  if (isSmoke) return smokeDefault;
  return fullDefault;
}

function parseRunArgs(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      suite: { type: 'string', default: ALL_SUITES },
      out: { type: 'string' },
      commit: { type: 'string', default: DEFAULT_COMMIT },
      smoke: { type: 'boolean', default: false },
      runs: { type: 'string' },
      warmup: { type: 'string' },
      profile: { type: 'string' },
      top: { type: 'string' },
      interval: { type: 'string' },
    },
    strict: true,
  });
  return values;
}

/**
 * Turn argv into run options. Throws UsageError on a missing `--out` or a bad value.
 * @param {string[]} argv
 */
export function parseOptions(argv) {
  const values = parseRunArgs(argv);
  const isSmoke = values.smoke;
  if (values.profile !== undefined) {
    return {
      profile: values.profile,
      out: values.out,
      commit: values.commit,
      isSmoke,
      runs: countOrDefault(values.runs, '--runs', PROFILE_RUNS),
      top: countOrDefault(values.top, '--top', PROFILE_TOP),
      interval: countOrDefault(
        values.interval,
        '--interval',
        PROFILE_INTERVAL_MICROSECONDS,
      ),
    };
  }
  if (!values.out) throw new UsageError('--out is required');
  return {
    suite: values.suite,
    out: values.out,
    commit: values.commit,
    isSmoke,
    runs: resolveCount({
      text: values.runs,
      flag: '--runs',
      minimum: 1,
      smokeDefault: SMOKE_RUNS,
      fullDefault: DEFAULT_RUNS,
      isSmoke,
    }),
    warmup: resolveCount({
      text: values.warmup,
      flag: '--warmup',
      minimum: 0,
      smokeDefault: SMOKE_WARMUP,
      fullDefault: DEFAULT_WARMUP,
      isSmoke,
    }),
  };
}

function selectSuiteNames(suite, suites) {
  if (suite === ALL_SUITES) return Object.keys(suites);
  if (!Object.hasOwn(suites, suite)) {
    throw new UsageError(
      `unknown suite "${suite}", expected ${[...Object.keys(suites), ALL_SUITES].join(', ')}`,
    );
  }
  return [suite];
}

async function measureSuite(suiteName, context, settings, deps) {
  const { cases } = await deps.SUITES[suiteName]();
  const workDir = mkdtempSync(join(tmpdir(), WORK_DIR_PREFIX));
  try {
    const benchCases = await cases({ ...context, workDir });
    return benchCases.map((benchCase) => {
      const { samplesMs } = deps.measureCase(benchCase, settings);
      const stats = summarize(samplesMs);
      return {
        id: `${suiteName}/${benchCase.name}`,
        suite: suiteName,
        name: benchCase.name,
        samplesMs,
        stats,
        gate: gateVerdict(stats, GATE),
      };
    });
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

async function allCaseIds(deps, context) {
  const ids = [];
  for (const suiteName of Object.keys(deps.SUITES)) {
    const workDir = mkdtempSync(join(tmpdir(), WORK_DIR_PREFIX));
    try {
      const { cases } = await deps.SUITES[suiteName]();
      for (const benchCase of await cases({ ...context, workDir })) {
        ids.push(`${suiteName}/${benchCase.name}`);
      }
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  }
  return ids;
}

async function unknownCaseError(id, deps, context) {
  const ids = await allCaseIds(deps, context);
  return new UsageError(
    `unknown case "${id}", expected one of ${ids.join(', ')}`,
  );
}

async function findProfileCase(id, context, workDir, deps) {
  const separator = id.indexOf('/');
  if (separator < 0) throw await unknownCaseError(id, deps, context);
  const suiteName = id.slice(0, separator);
  const caseName = id.slice(separator + 1);
  if (!Object.hasOwn(deps.SUITES, suiteName)) {
    throw await unknownCaseError(id, deps, context);
  }
  const { cases } = await deps.SUITES[suiteName]();
  const benchCases = await cases({ ...context, workDir });
  const benchCase = benchCases.find((entry) => entry.name === caseName);
  if (!benchCase) throw await unknownCaseError(id, deps, context);
  return benchCase;
}

/**
 * Profile one case, print the JSON, write it to `options.out` when given, and return the exit
 * code. Throws on any setup error.
 *
 * @param {{ profile: string, out?: string, commit: string, runs: number, top: number, interval: number }} options
 * @param {Partial<typeof REAL_DEPS> & { repoDir?: string, profilesRoot?: string, log?: (line: string) => void }} [overrides]
 * @returns {Promise<number>} the process exit code
 */
export async function runProfile(options, overrides = {}) {
  const deps = {
    ...REAL_DEPS,
    repoDir: REPO_DIR,
    log: console.log,
    ...overrides,
  };
  const build = deps.ensureBuild(options.commit, { repoDir: deps.repoDir });
  const context = { root: build.root, repoDir: deps.repoDir };
  const workDir = mkdtempSync(join(tmpdir(), WORK_DIR_PREFIX));
  try {
    const benchCase = await findProfileCase(
      options.profile,
      context,
      workDir,
      deps,
    );
    const result = deps.profileCase(benchCase, {
      id: options.profile,
      build: { root: build.root, sha: build.commit },
      runs: options.runs,
      top: options.top,
      interval: options.interval,
      profilesRoot: deps.profilesRoot,
    });
    const json = `${JSON.stringify(result, null, 2)}\n`;
    if (options.out) {
      mkdirSync(dirname(resolve(options.out)), { recursive: true });
      writeFileSync(options.out, json);
    }
    deps.log(json.trimEnd());
    return EXIT_OK;
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

function formatCaseLine(measured) {
  const { id, stats, gate } = measured;
  return [
    id,
    `median ${stats.median.toFixed(1)}ms`,
    `p95 ${stats.p95.toFixed(1)}ms`,
    `relMad ${stats.relMad.toFixed(4)}`,
    gate,
  ].join('  ');
}

function buildResult({ options, build, settings, cases, machine }) {
  const hasFailure = cases.some((measured) => measured.gate === VERDICT.fail);
  return {
    schemaVersion: SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
    mode: options.isSmoke ? MODE.smoke : MODE.full,
    requested: options.commit,
    machine,
    build: { root: build.root, cached: build.cached },
    settings,
    gate: GATE,
    cases,
    verdict: hasFailure ? VERDICT.fail : VERDICT.pass,
  };
}

/**
 * Build the commit, measure the chosen suites, write the JSON, and return the exit code.
 * Throws on any setup error, and writes nothing in that case.
 *
 * @param {{ suite: string, out: string, commit: string, isSmoke: boolean, runs: number, warmup: number }} options
 * @param {Partial<typeof REAL_DEPS> & { repoDir?: string, log?: (line: string) => void }} [deps]
 * @returns {Promise<number>} the process exit code
 */
export async function runBench(options, deps = {}) {
  const resolved = {
    ...REAL_DEPS,
    repoDir: REPO_DIR,
    log: console.log,
    ...deps,
  };
  const suiteNames = selectSuiteNames(options.suite, resolved.SUITES);
  const build = resolved.ensureBuild(options.commit, {
    repoDir: resolved.repoDir,
  });
  const settings = { warmup: options.warmup, runs: options.runs };
  const context = { root: build.root, repoDir: resolved.repoDir };
  const cases = [];
  for (const suiteName of suiteNames) {
    cases.push(...(await measureSuite(suiteName, context, settings, resolved)));
  }
  const result = buildResult({
    options,
    build,
    settings,
    cases,
    machine: resolved.machineFacts(build.commit),
  });
  mkdirSync(dirname(resolve(options.out)), { recursive: true });
  writeFileSync(options.out, `${JSON.stringify(result, null, 2)}\n`);
  for (const measured of cases) resolved.log(formatCaseLine(measured));
  return result.verdict === VERDICT.fail ? EXIT_GATE_FAIL : EXIT_OK;
}

async function main() {
  try {
    const options = parseOptions(process.argv.slice(2));
    process.exitCode =
      options.profile === undefined
        ? await runBench(options)
        : await runProfile(options);
  } catch (error) {
    console.error(`bench: ${error.message}`);
    process.exitCode = EXIT_SETUP_ERROR;
  }
}

const isRunDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (isRunDirectly) await main();
