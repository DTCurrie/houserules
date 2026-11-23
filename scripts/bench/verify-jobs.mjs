#!/usr/bin/env node
/**
 * Times one multi-package verify scope two ways: its package jobs one after another (jobs 1,
 * the serial arm) and all started together (jobs 3, the concurrent arm), cold and warm. It
 * prints one line per round with the arm, the one-minute load at the round's start, the wall
 * seconds, and every job's exit, then a summary table and the flipped rounds.
 *
 * Usage, from anywhere:
 *   node scripts/bench/verify-jobs.mjs [--packages a,b,c] [--rounds 5] [--json <file>] [--dry-run]
 *
 * A job is the unit of `runScope` in verify-changed: `<runner> --filter <package> run <command>`
 * for each verify command in turn, stopping at the first failure. Cold deletes each cleared
 * package's `.wireit` directory before the round. Warm runs after an untimed priming round, and
 * a warm row is valid only when the row before it passed with the git tree unchanged. Rounds run
 * back to back with no load wait, so read the load column. It never edits a tracked file.
 * Exit codes: 0 when every round ran, whatever the rounds returned, and 2 on a usage error.
 */
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { loadavg } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { summarize } from './stats.mjs';

const REPO_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const DEFAULT_PACKAGES = [
  '@houserules/plugin-backlog',
  '@houserules/plugin-decisions',
  '@houserules/plugin-changesets',
];
const DEFAULT_COMMANDS = ['check', 'test'];
const DEFAULT_ROUNDS = 5;
const ARMS = ['serial', 'concurrent'];
const TEMPERATURES = ['cold', 'warm'];

const WIREIT_STATE_DIR = '.wireit';
const DEFAULT_RUNNER = 'pnpm';
const DEFAULT_FILTER_FLAG = '--filter';
const DEFAULT_TIMEOUT_MS = 600_000;
const OUTPUT_TAIL_CHARS = 64 * 1024;
const ERROR_LINE_CHARS = 240;
const DISPLAYED_DECIMALS = 2;
const NANOSECONDS_PER_MILLISECOND = 1e6;
const MILLISECONDS_PER_SECOND = 1000;
const EXIT_USAGE = 2;
const ERROR_PATTERN = /error|fail|fatal|heap|killed|ERR_/i;
// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\u001b\[[0-9;]*[A-Za-z]/g;
const SCOPE_PREFIX = /^@[^/]+\//;

const OPTION_SPEC = {
  packages: { type: 'string' },
  commands: { type: 'string' },
  clear: { type: 'string' },
  rounds: { type: 'string' },
  temperatures: { type: 'string' },
  root: { type: 'string' },
  runner: { type: 'string' },
  'filter-flag': { type: 'string' },
  'timeout-ms': { type: 'string' },
  json: { type: 'string' },
  'dry-run': { type: 'boolean' },
};

export class UsageError extends Error {}

function splitCommaList(value) {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function positiveInteger(value, flag) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new UsageError(`${flag} takes a positive integer, got ${value}`);
  }
  return parsed;
}

export function parseOptions(argv) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: OPTION_SPEC,
      strict: true,
    }));
  } catch (error) {
    throw new UsageError(error.message);
  }
  const packages = values.packages
    ? splitCommaList(values.packages)
    : DEFAULT_PACKAGES;
  if (packages.length === 0) throw new UsageError('--packages is empty');
  const temperatures = values.temperatures
    ? splitCommaList(values.temperatures)
    : TEMPERATURES;
  const unknown = temperatures.filter((name) => !TEMPERATURES.includes(name));
  if (unknown.length > 0) {
    throw new UsageError(
      `--temperatures takes cold and warm, got ${unknown.join(', ')}`,
    );
  }
  return {
    packages,
    commands: values.commands
      ? splitCommaList(values.commands)
      : DEFAULT_COMMANDS,
    clear: values.clear ? splitCommaList(values.clear) : packages,
    rounds: values.rounds
      ? positiveInteger(values.rounds, '--rounds')
      : DEFAULT_ROUNDS,
    temperatures,
    root: resolve(values.root ?? REPO_DIR),
    runner: values.runner ?? DEFAULT_RUNNER,
    filterFlag: values['filter-flag'] ?? DEFAULT_FILTER_FLAG,
    timeoutMs: values['timeout-ms']
      ? positiveInteger(values['timeout-ms'], '--timeout-ms')
      : DEFAULT_TIMEOUT_MS,
    jsonPath: values.json ? resolve(values.json) : null,
    isDryRun: values['dry-run'] ?? false,
  };
}

/** Maps each workspace package name under `<root>/packages` to its directory. */
function packageDirectories(root) {
  const base = join(root, 'packages');
  const directories = new Map();
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    const manifest = join(base, entry.name, 'package.json');
    if (!entry.isDirectory() || !existsSync(manifest)) continue;
    const { name } = JSON.parse(readFileSync(manifest, 'utf8'));
    directories.set(name, join(base, entry.name));
  }
  return directories;
}

function assertPackagesExist(names, directories, flag) {
  const missing = names.filter((name) => !directories.has(name));
  if (missing.length > 0) {
    throw new UsageError(
      `${flag} names no workspace package: ${missing.join(', ')}`,
    );
  }
}

function jobSteps(packageName, { commands, runner, filterFlag }) {
  return commands.map((command) => ({
    command,
    file: runner,
    args: [filterFlag, packageName, 'run', command],
  }));
}

/**
 * The rounds in run order. Each temperature runs `rounds` rounds of both arms, and the lead arm
 * alternates so neither always runs second. Warm opens with one untimed serial priming round.
 */
export function schedule(rounds, temperatures) {
  const plan = [];
  for (const temperature of temperatures) {
    if (temperature === 'warm') {
      plan.push({ temperature, round: 0, arm: 'serial', isTimed: false });
    }
    for (let round = 1; round <= rounds; round++) {
      const order = round % 2 === 1 ? ARMS : [...ARMS].reverse();
      for (const arm of order) {
        plan.push({ temperature, round, arm, isTimed: true });
      }
    }
  }
  return plan;
}

export function errorLine(output) {
  const lines = output
    .replace(ANSI_PATTERN, '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const line =
    lines.findLast((candidate) => ERROR_PATTERN.test(candidate)) ??
    lines.at(-1) ??
    '';
  return line.slice(0, ERROR_LINE_CHARS);
}

function runStep(step, { cwd, env, timeoutMs }) {
  return new Promise((done) => {
    let output = '';
    const keep = (chunk) => {
      output = (output + chunk).slice(-OUTPUT_TAIL_CHARS);
    };
    const child = spawn(step.file, step.args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
    });
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    child.on('error', (error) => {
      keep(`\n${error.message}\n`);
    });
    child.on('close', (status, signal) => done({ status, signal, output }));
  });
}

function elapsedMs(start) {
  return Number(process.hrtime.bigint() - start) / NANOSECONDS_PER_MILLISECOND;
}

async function runJob(job, context) {
  const start = process.hrtime.bigint();
  for (const step of job.steps) {
    const stepResult = await runStep(step, context);
    if (stepResult.status !== 0) {
      return {
        package: job.package,
        exit: stepResult.status,
        signal: stepResult.signal,
        failedStep: step.command,
        ms: elapsedMs(start),
        errorLine: errorLine(stepResult.output),
      };
    }
  }
  return {
    package: job.package,
    exit: 0,
    signal: null,
    failedStep: null,
    ms: elapsedMs(start),
    errorLine: null,
  };
}

async function runArm(arm, jobs, context) {
  const start = process.hrtime.bigint();
  let results;
  if (arm === 'serial') {
    results = [];
    for (const job of jobs) results.push(await runJob(job, context));
  } else {
    results = await Promise.all(jobs.map((job) => runJob(job, context)));
  }
  return { wallMs: elapsedMs(start), jobs: results };
}

function clearWireitState(directories) {
  for (const directory of directories) {
    rmSync(join(directory, WIREIT_STATE_DIR), { recursive: true, force: true });
  }
}

/** The tree's `git status`, so a warm row can prove no file changed. Null outside git. */
function treeState(root) {
  const status = spawnSync('git', ['status', '--porcelain=v1', '-uall'], {
    cwd: root,
    encoding: 'utf8',
  });
  return status.status === 0 ? status.stdout : null;
}

async function execute(plan, jobs, context, onRow) {
  const rows = [];
  let previous = null;
  for (const entry of plan) {
    if (entry.temperature === 'cold')
      clearWireitState(context.clearDirectories);
    const tree = treeState(context.cwd);
    const load = loadavg()[0];
    const { wallMs, jobs: results } = await runArm(entry.arm, jobs, context);
    const row = {
      ...entry,
      load,
      wallMs,
      hasPassed: results.every((job) => job.exit === 0),
      jobs: results,
    };
    if (entry.temperature === 'warm') {
      row.isWarmValid =
        previous !== null && previous.hasPassed && previous.tree === tree;
    }
    rows.push(row);
    onRow(row);
    previous = { hasPassed: row.hasPassed, tree: treeState(context.cwd) };
  }
  return rows;
}

function shortName(packageName) {
  return packageName.replace(SCOPE_PREFIX, '');
}

function exitLabel(job) {
  return job.signal ?? String(job.exit);
}

function seconds(milliseconds) {
  return (milliseconds / MILLISECONDS_PER_SECOND).toFixed(DISPLAYED_DECIMALS);
}

function formatRow(row) {
  const round = row.isTimed ? `r${row.round}` : 'prime';
  const exits = row.jobs
    .map((job) => `${shortName(job.package)}:${exitLabel(job)}`)
    .join(',');
  const load = row.load.toFixed(DISPLAYED_DECIMALS);
  const warmInvalidSuffix = row.isWarmValid === false ? ' warm-invalid' : '';
  return `${row.temperature} ${round} ${row.arm} load=${load} wall=${seconds(row.wallMs)}s exits=${exits}${warmInvalidSuffix}`;
}

function summarizeArm(temperature, arm, rows) {
  const stats = summarize(rows.map((row) => row.wallMs));
  return {
    temperature,
    arm,
    sampleCount: stats.n,
    passedCount: rows.filter((row) => row.hasPassed).length,
    medianMs: stats.median,
    minMs: stats.min,
    maxMs: stats.max,
    spreadMs: stats.max - stats.min,
  };
}

function medianGap(serial, concurrent) {
  const gapMs = serial.medianMs - concurrent.medianMs;
  const spreadMs = Math.max(serial.spreadMs, concurrent.spreadMs);
  return {
    temperature: serial.temperature,
    gapMs,
    spreadMs,
    exceedsSpread: Math.abs(gapMs) > spreadMs,
  };
}

function findFlips(timed, temperature) {
  const ofTemperature = timed.filter((row) => row.temperature === temperature);
  const flips = [];
  for (const concurrent of ofTemperature.filter(
    (row) => row.arm === 'concurrent',
  )) {
    const serial = ofTemperature.find(
      (row) => row.arm === 'serial' && row.round === concurrent.round,
    );
    if (!serial?.hasPassed || concurrent.hasPassed) continue;
    const errors = concurrent.jobs
      .filter((job) => job.exit !== 0)
      .map((job) => ({
        package: job.package,
        step: job.failedStep,
        line: job.errorLine,
      }));
    flips.push({ temperature, round: concurrent.round, errors });
  }
  return flips;
}

/**
 * Per temperature and arm: the wall-time spread. Per temperature: the serial median minus the
 * concurrent median, and whether that gap exceeds the wider arm's min-to-max spread. A flip is a
 * round where the concurrent arm failed and the serial arm of the same round passed.
 */
export function summarizeRows(rows) {
  const timed = rows.filter((row) => row.isTimed);
  const arms = [];
  const gaps = [];
  const flips = [];
  for (const temperature of TEMPERATURES) {
    const byArm = {};
    for (const arm of ARMS) {
      const set = timed.filter(
        (row) => row.temperature === temperature && row.arm === arm,
      );
      if (set.length === 0) continue;
      byArm[arm] = summarizeArm(temperature, arm, set);
      arms.push(byArm[arm]);
    }
    if (byArm.serial && byArm.concurrent) {
      gaps.push(medianGap(byArm.serial, byArm.concurrent));
    }
    flips.push(...findFlips(timed, temperature));
  }
  return { arms, gaps, flips };
}

export function formatSummary(summary) {
  const lines = [
    '| temperature | arm | n | passed | median s | min s | max s | spread s |',
    '| ----------- | --- | - | ------ | -------- | ----- | ----- | -------- |',
  ];
  for (const arm of summary.arms) {
    lines.push(
      `| ${arm.temperature} | ${arm.arm} | ${arm.sampleCount} | ${arm.passedCount} | ${seconds(arm.medianMs)} | ${seconds(arm.minMs)} | ${seconds(arm.maxMs)} | ${seconds(arm.spreadMs)} |`,
    );
  }
  lines.push('');
  for (const gap of summary.gaps) {
    const verdict = gap.exceedsSpread ? 'exceeds' : 'does not exceed';
    lines.push(
      `${gap.temperature}: serial median minus concurrent median is ${seconds(gap.gapMs)}s, which ${verdict} the wider spread of ${seconds(gap.spreadMs)}s`,
    );
  }
  lines.push(`flipped rounds: ${summary.flips.length}`);
  for (const flip of summary.flips) {
    for (const error of flip.errors) {
      lines.push(
        `- ${flip.temperature} r${flip.round} ${shortName(error.package)} ${error.step}: ${error.line}`,
      );
    }
  }
  return lines.join('\n');
}

function printPlan(out, { options, jobs, plan, clearDirectories }) {
  const jobLines = jobs.map((job) =>
    job.steps.map((step) => [step.file, ...step.args].join(' ')).join(' && '),
  );
  const untimed = plan.filter((entry) => !entry.isTimed).length;
  out(`root ${options.root}`);
  out(`jobs ${jobLines.join(' | ')}`);
  out(
    `cold clears ${clearDirectories.map((directory) => join(directory, WIREIT_STATE_DIR)).join(' ')}`,
  );
  out(`rounds ${plan.length} (${untimed} untimed)`);
}

function writeRecord(jsonPath, record) {
  writeFileSync(jsonPath, `${JSON.stringify(record, null, 2)}\n`);
}

async function main(argv) {
  const options = parseOptions(argv);
  const directories = packageDirectories(options.root);
  assertPackagesExist(options.packages, directories, '--packages');
  assertPackagesExist(options.clear, directories, '--clear');
  const clearDirectories = options.clear.map((name) => directories.get(name));
  const jobs = options.packages.map((packageName) => ({
    package: packageName,
    steps: jobSteps(packageName, options),
  }));
  const plan = schedule(options.rounds, options.temperatures);
  const out = (line) => process.stdout.write(`${line}\n`);

  printPlan(out, { options, jobs, plan, clearDirectories });
  if (options.isDryRun) {
    for (const entry of plan) {
      out(
        `${entry.temperature} ${entry.isTimed ? `r${entry.round}` : 'prime'} ${entry.arm}`,
      );
    }
    return 0;
  }

  const context = {
    cwd: options.root,
    env: { ...process.env, FORCE_COLOR: '0' },
    timeoutMs: options.timeoutMs,
    clearDirectories,
  };
  const started = process.hrtime.bigint();
  const rows = await execute(plan, jobs, context, (row) => out(formatRow(row)));
  const summary = summarizeRows(rows);
  out('');
  out(formatSummary(summary));
  out(`total ${seconds(elapsedMs(started))}s`);
  if (options.jsonPath) {
    const createdAt = new Date().toISOString();
    writeRecord(options.jsonPath, { createdAt, options, rows, summary });
  }
  return 0;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(`verify-jobs: ${error.message}\n`);
      process.exit(EXIT_USAGE);
    },
  );
}
