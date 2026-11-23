#!/usr/bin/env node
/**
 * Check an eval-probes workflow dispatch before any runner spends money.
 *
 * Command:
 *   node scripts/eval/actions-plan.mjs matrix --fixture <dir> --arms <a,b> --samples <n>
 *     --per-run <usd> --margin <ratio> --total <usd> [--root <dir>]
 *   node scripts/eval/actions-plan.mjs bench --path <p> [--root <dir>]
 *
 * Subcommands:
 *   matrix  Refuses a fixture outside `scripts/eval/fixtures`, an arm `loadArmFixture`
 *           refuses, an empty or repeated arm list, a bad number, and a worst case over
 *           `--total`. The worst case is arms times `--samples` times `--per-run` times one
 *           plus `--margin`. On success prints one JSON line
 *           `{"include":[{"arm":"<a>","sample":<k>},...]}`, arms in input order, samples 1 to n.
 *   bench   Refuses a path that is not an existing `.mjs` file under `scripts/bench`. On
 *           success prints the path relative to the root.
 *
 * Options:
 *   --root  The repo root (default: the root this script sits in).
 *
 * Exit codes:
 *   0  the plan passed.
 *   2  a refusal or a bad flag, with the reason on stderr.
 */
import { statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { loadArmFixture, requireCommittedFixture } from './fixture-arm.mjs';

const DEFAULT_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);
const BENCH_DIR = join('scripts', 'bench');
const EXIT_REFUSED = 2;
/** Dollars are compared in millionths so a total met exactly is not lost to float error. */
const MICRO = 1e6;

/** A flag or value that refuses the plan. */
class UsageError extends Error {}

/**
 * @param {string | undefined} text
 * @param {string} flag
 * @returns {string}
 */
function requireFlag(text, flag) {
  if (text === undefined) throw new UsageError(`${flag} is required`);
  return text;
}

/**
 * @param {string | undefined} text
 * @param {string} flag
 * @param {boolean} allowZero
 * @returns {number}
 */
function parseNumber(text, flag, allowZero) {
  const value = Number(requireFlag(text, flag));
  const ok = Number.isFinite(value) && (allowZero ? value >= 0 : value > 0);
  if (ok) return value;
  throw new UsageError(
    `${flag} must be a ${allowZero ? 'non-negative' : 'positive'} number, got "${text}"`,
  );
}

/**
 * Builds the matrix, or throws `UsageError` naming the refusal.
 *
 * @param {{ fixture?: string, arms?: string, samples?: string, 'per-run'?: string, margin?: string, total?: string }} values
 * @param {string} root
 * @returns {{ include: Array<{ arm: string, sample: number }> }}
 */
function planMatrix(values, root) {
  const fixture = resolve(root, requireFlag(values.fixture, '--fixture'));
  const armText = requireFlag(values.arms, '--arms');
  const samplesText = requireFlag(values.samples, '--samples');
  const samples = Number(samplesText);
  if (!Number.isInteger(samples) || samples <= 0) {
    throw new UsageError(
      `--samples must be a positive integer, got "${samplesText}"`,
    );
  }
  const perRun = parseNumber(values['per-run'], '--per-run', false);
  const total = parseNumber(values.total, '--total', false);
  const margin = parseNumber(values.margin, '--margin', true);
  const arms = armText.split(',').map((arm) => arm.trim());
  if (arms.some((arm) => arm === '')) {
    throw new UsageError(`--arms has an empty arm, got "${armText}"`);
  }
  const repeated = arms.find((arm, index) => arms.indexOf(arm) !== index);
  if (repeated !== undefined) {
    throw new UsageError(`--arms repeats "${repeated}"`);
  }
  try {
    requireCommittedFixture(fixture, root);
    for (const arm of arms) loadArmFixture(fixture, arm);
  } catch (error) {
    throw new UsageError(
      error instanceof Error ? error.message : String(error),
    );
  }
  const worstCase = arms.length * samples * perRun * (1 + margin);
  if (Math.round(worstCase * MICRO) > Math.round(total * MICRO)) {
    throw new UsageError(
      `worst case $${worstCase.toFixed(4)} exceeds --total $${total}`,
    );
  }
  const include = arms.flatMap((arm) =>
    Array.from({ length: samples }, (_, index) => ({ arm, sample: index + 1 })),
  );
  return { include };
}

/**
 * Returns the bench path relative to the root, or throws `UsageError`.
 *
 * @param {string | undefined} path
 * @param {string} root
 * @returns {string}
 */
function planBench(path, root) {
  const target = resolve(root, requireFlag(path, '--path'));
  const fromBench = relative(resolve(root, BENCH_DIR), target);
  const inside =
    fromBench !== '' &&
    !isAbsolute(fromBench) &&
    !fromBench.split(/[\\/]+/).includes('..');
  if (!inside || !target.endsWith('.mjs')) {
    throw new UsageError(
      `--path ${path} is not a .mjs file under ${BENCH_DIR}`,
    );
  }
  const isFile = statSync(target, { throwIfNoEntry: false })?.isFile() ?? false;
  if (!isFile) throw new UsageError(`--path ${path} is not an existing file`);
  return relative(root, target);
}

/**
 * @param {string[]} argv
 * @returns {string}
 */
function run(argv) {
  const [command, ...rest] = argv;
  const { values } = parseArgs({
    args: rest,
    options: {
      fixture: { type: 'string' },
      arms: { type: 'string' },
      samples: { type: 'string' },
      'per-run': { type: 'string' },
      margin: { type: 'string' },
      total: { type: 'string' },
      path: { type: 'string' },
      root: { type: 'string' },
    },
    strict: true,
    allowPositionals: false,
  });
  const root = resolve(values.root ?? DEFAULT_ROOT);
  if (command === 'matrix') return JSON.stringify(planMatrix(values, root));
  if (command === 'bench') return planBench(values.path, root);
  throw new UsageError(
    `unknown subcommand "${command}", expected matrix or bench`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    process.stdout.write(`${run(process.argv.slice(2))}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`actions-plan: ${message}\n`);
    process.exit(EXIT_REFUSED);
  }
}
