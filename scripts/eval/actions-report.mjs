#!/usr/bin/env node
/**
 * The two reports the eval-probes workflow calls.
 *
 *   node scripts/eval/actions-report.mjs record --out <dir> --arm <a> --sample <k>
 *        --mode paid|dry-run --exit <code> --wall <seconds> --image <name> --file <path>
 *     Writes one record JSON for a matrix job.
 *   node scripts/eval/actions-report.mjs table <dir>
 *     Reads every `*.json` record under <dir> at any depth and prints the Markdown table.
 *
 * Exits 2 on a usage error.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { judgeArmValidity } from './fixture-arm.mjs';
import { armSessionDir } from './layout.mjs';
import { loadSample } from './orchestrate-report.mjs';

const MODES = ['paid', 'dry-run'];
const EXIT_USAGE = 2;
/** The `valid` cell for each record value. Anything else, null for a dry run, reads `dry run`. */
const VALID_TEXT = { true: 'yes', false: 'no' };

const TIE_NOTE = 'A wall-time gap under 10% across runners reads as a tie.';

class UsageError extends Error {}

function integerFlag(name, value) {
  if (value === undefined || !/^\d+$/.test(value)) {
    throw new UsageError(`--${name} must be a non-negative integer`);
  }
  return Number(value);
}

function requireString(name, value) {
  if (value === undefined || value === '') {
    throw new UsageError(`--${name} is required`);
  }
  return value;
}

/** The last `result` event's `total_cost_usd`, or null. */
function costOf(sample) {
  const result = sample.stream
    .filter((event) => event?.type === 'result')
    .at(-1);
  const cost = result?.total_cost_usd;
  return typeof cost === 'number' ? cost : null;
}

/**
 * Validity and cost of a paid sample directory, each null when its artifact is missing.
 *
 * @param {string} out
 * @param {string} arm
 * @param {number} sample
 * @returns {{ valid: boolean | null, costUsd: number | null }}
 */
function readPaidSample(out, arm, sample) {
  const loaded = loadSample(armSessionDir(out, { arm, sample }));
  const agent = loaded.run?.validityAgent;
  const hasArtifacts =
    loaded.run !== null &&
    loaded.stream.length > 0 &&
    typeof agent === 'string';
  return {
    valid: hasArtifacts ? judgeArmValidity(loaded, agent).valid : null,
    costUsd: costOf(loaded),
  };
}

function parseRecordArgs(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      out: { type: 'string' },
      arm: { type: 'string' },
      sample: { type: 'string' },
      mode: { type: 'string' },
      exit: { type: 'string' },
      wall: { type: 'string' },
      image: { type: 'string' },
      file: { type: 'string' },
    },
    strict: true,
    allowPositionals: false,
  });
  if (!MODES.includes(values.mode ?? '')) {
    throw new UsageError('--mode must be paid or dry-run');
  }
  const wall = Number(values.wall);
  if (values.wall === undefined || values.wall.trim() === '' || !(wall >= 0)) {
    throw new UsageError('--wall must be a non-negative number');
  }
  return {
    out: requireString('out', values.out),
    arm: requireString('arm', values.arm),
    sample: integerFlag('sample', values.sample),
    mode: values.mode,
    exitCode: integerFlag('exit', values.exit),
    wall,
    image: requireString('image', values.image),
    file: requireString('file', values.file),
  };
}

/** The record the `record` command writes. */
function buildRecord(options) {
  const paid =
    options.mode === 'paid'
      ? readPaidSample(options.out, options.arm, options.sample)
      : { valid: null, costUsd: null };
  return {
    arm: options.arm,
    sample: options.sample,
    mode: options.mode,
    exitCode: options.exitCode,
    valid: paid.valid,
    costUsd: paid.costUsd,
    wallSeconds: options.wall,
    runnerImage: options.image,
  };
}

/** Orders records by arm name, code unit by code unit, then by sample number. */
function compareRecords(left, right) {
  if (left.arm !== right.arm) return left.arm < right.arm ? -1 : 1;
  return left.sample - right.sample;
}

/**
 * The Markdown table and the tie note for a set of records, sorted by arm then sample.
 *
 * @param {object[]} records
 * @returns {string}
 */
export function buildTable(records) {
  const sorted = [...records].sort(compareRecords);
  const validText = (valid) => VALID_TEXT[String(valid)] ?? 'dry run';
  const costText = (cost) =>
    typeof cost === 'number' ? `$${cost.toFixed(2)}` : 'n/a';
  const lines = [
    '| arm | sample | valid | cost | wall s | runner image |',
    '| --- | --- | --- | --- | --- | --- |',
    ...sorted.map(
      (record) =>
        `| ${record.arm} | ${record.sample} | ${validText(record.valid)} | ${costText(record.costUsd)} | ${Number(record.wallSeconds).toFixed(1)} | ${record.runnerImage} |`,
    ),
  ];
  return `${lines.join('\n')}\n\n${TIE_NOTE}\n`;
}

function collectRecords(dir) {
  const records = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) records.push(...collectRecords(path));
    else if (entry.name.endsWith('.json')) {
      try {
        records.push(JSON.parse(readFileSync(path, 'utf8')));
      } catch {
        // A file that is not a record is skipped.
      }
    }
  }
  return records;
}

function main(argv) {
  const [command, ...rest] = argv;
  if (command === 'record') {
    const options = parseRecordArgs(rest);
    mkdirSync(dirname(options.file), { recursive: true });
    writeFileSync(
      options.file,
      `${JSON.stringify(buildRecord(options), null, 2)}\n`,
    );
    return;
  }
  if (command === 'table') {
    if (rest.length !== 1) throw new UsageError('table takes one directory');
    process.stdout.write(buildTable(collectRecords(rest[0])));
    return;
  }
  throw new UsageError('usage: actions-report.mjs record|table ...');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    if (
      error instanceof UsageError ||
      String(error?.code).startsWith('ERR_PARSE_ARGS')
    ) {
      process.stderr.write(`${error.message}\n`);
      process.exit(EXIT_USAGE);
    }
    throw error;
  }
}
