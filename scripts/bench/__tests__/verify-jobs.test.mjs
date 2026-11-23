import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  errorLine,
  formatSummary,
  parseOptions,
  schedule,
  summarizeRows,
  UsageError,
} from '../verify-jobs.mjs';

const SCRIPT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'verify-jobs.mjs',
);
const STUB_SLEEP_MS = 400;
const OVERLAP_SLEEP_MS = 1500;
const MILLISECONDS_PER_SECOND = 1000;
const PACKAGE_NAMES = ['a', 'b', 'c'];
const JOBS_PER_ROUND = PACKAGE_NAMES.length * 2;

const PNPM_STAND_IN_FAILING_UNDER_CONTENTION = `#!/usr/bin/env node
const { appendFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const [, packageName, , command] = process.argv.slice(2);
const root = process.cwd();
const state = join(root, 'packages', packageName, '.wireit');
const running = join(root, 'running');
mkdirSync(running, { recursive: true });
const others = readdirSync(running).filter((name) => name !== packageName);
writeFileSync(join(running, packageName), '');
const start = Date.now();
const hadState = existsSync(state);
setTimeout(() => {
  mkdirSync(state, { recursive: true });
  rmSync(join(running, packageName), { force: true });
  appendFileSync(join(root, 'log.jsonl'), JSON.stringify({ packageName, command, start, end: Date.now(), hadState }) + '\\n');
  if (process.env.STUB_MODE === 'contend' && others.length > 0) {
    console.error('Error: lock held by another job');
    process.exit(1);
  }
}, Number(process.env.STUB_SLEEP_MS));
`;

function makeWorkspace(base, name) {
  const root = join(base, name);
  for (const packageName of PACKAGE_NAMES) {
    mkdirSync(join(root, 'packages', packageName, '.wireit'), {
      recursive: true,
    });
    writeFileSync(
      join(root, 'packages', packageName, 'package.json'),
      JSON.stringify({ name: packageName }),
    );
  }
  return root;
}

function runProbe(root, runner, extraArgs = [], env = {}) {
  return spawnSync(
    process.execPath,
    [
      SCRIPT,
      '--root',
      root,
      '--runner',
      runner,
      '--packages',
      PACKAGE_NAMES.join(','),
      '--commands',
      'check',
      ...extraArgs,
    ],
    {
      encoding: 'utf8',
      env: { ...process.env, STUB_SLEEP_MS: String(STUB_SLEEP_MS), ...env },
    },
  );
}

function readLog(root) {
  return readFileSync(join(root, 'log.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
}

describe('parseOptions', () => {
  it('defaults to three plugins, check then test, five rounds, cold then warm', () => {
    const options = parseOptions([]);

    assert.deepEqual(options.packages, [
      '@houserules/plugin-backlog',
      '@houserules/plugin-decisions',
      '@houserules/plugin-changesets',
    ]);
    assert.deepEqual(options.commands, ['check', 'test']);
    assert.deepEqual(options.clear, options.packages);
    assert.equal(options.rounds, 5);
    assert.deepEqual(options.temperatures, ['cold', 'warm']);
    assert.equal(options.runner, 'pnpm');
    assert.equal(options.filterFlag, '--filter');
  });

  it('rejects an unknown temperature, a zero round count, and an unknown flag', () => {
    assert.throws(() => parseOptions(['--temperatures', 'hot']), UsageError);
    assert.throws(() => parseOptions(['--rounds', '0']), UsageError);
    assert.throws(() => parseOptions(['--jobs', '3']), UsageError);
  });
});

describe('schedule', () => {
  it('alternates the lead arm per round and primes warm with one untimed serial round', () => {
    const order = schedule(2, ['cold', 'warm']).map(
      (entry) =>
        `${entry.temperature} ${entry.round} ${entry.arm} ${entry.isTimed}`,
    );

    assert.deepEqual(order, [
      'cold 1 serial true',
      'cold 1 concurrent true',
      'cold 2 concurrent true',
      'cold 2 serial true',
      'warm 0 serial false',
      'warm 1 serial true',
      'warm 1 concurrent true',
      'warm 2 concurrent true',
      'warm 2 serial true',
    ]);
  });
});

describe('errorLine', () => {
  it('takes the last line naming an error, with color codes stripped', () => {
    const output =
      'Error: first\n\u001b[31mFAIL src/a.test.ts\u001b[39m\nsummary line\n\n';

    assert.equal(errorLine(output), 'FAIL src/a.test.ts');
  });

  it('falls back to the last non-empty line', () => {
    assert.equal(errorLine('one\ntwo\n\n'), 'two');
  });
});

describe('summarizeRows', () => {
  const job = (exit, line) => ({
    package: '@scope/a',
    exit,
    signal: null,
    failedStep: exit === 0 ? null : 'test',
    errorLine: line,
  });
  const passingRow = (temperature, round, arm, seconds) => ({
    temperature,
    round,
    arm,
    isTimed: true,
    wallMs: seconds * MILLISECONDS_PER_SECOND,
    hasPassed: true,
    jobs: [job(0, null)],
  });
  const failingRow = (temperature, round, arm, seconds, line) => ({
    ...passingRow(temperature, round, arm, seconds),
    hasPassed: false,
    jobs: [job(1, line)],
  });
  const rows = [
    passingRow('cold', 1, 'serial', 30),
    failingRow('cold', 1, 'concurrent', 12, 'Error: heap out of memory'),
    passingRow('cold', 2, 'concurrent', 14),
    passingRow('cold', 2, 'serial', 34),
    passingRow('cold', 3, 'serial', 32),
    passingRow('cold', 3, 'concurrent', 10),
    failingRow('warm', 1, 'serial', 3, 'FAIL x'),
    failingRow('warm', 1, 'concurrent', 2, 'FAIL x'),
    passingRow('warm', 2, 'serial', 1),
    { ...passingRow('warm', 0, 'serial', 99), isTimed: false },
  ];
  const summary = summarizeRows(rows);
  const findArm = (temperature, arm) =>
    summary.arms.find(
      (entry) => entry.temperature === temperature && entry.arm === arm,
    );
  const findGap = (temperature) =>
    summary.gaps.find((gap) => gap.temperature === temperature);

  it('gives median, min, max, and spread per temperature and arm', () => {
    assert.deepEqual(
      { ...findArm('cold', 'serial') },
      {
        temperature: 'cold',
        arm: 'serial',
        sampleCount: 3,
        passedCount: 3,
        medianMs: 32000,
        minMs: 30000,
        maxMs: 34000,
        spreadMs: 4000,
      },
    );
  });

  it('leaves untimed rows out of the spread', () => {
    const warmSerial = findArm('warm', 'serial');

    assert.deepEqual(
      [warmSerial.sampleCount, warmSerial.medianMs, warmSerial.spreadMs],
      [2, 2000, 2000],
    );
  });

  it('reports whether the median gap exceeds the wider spread', () => {
    assert.deepEqual(findGap('cold'), {
      temperature: 'cold',
      gapMs: 20000,
      spreadMs: 4000,
      exceedsSpread: true,
    });
    assert.equal(findGap('warm').exceedsSpread, false);
  });

  it('counts a flip only where concurrent failed and the same round of serial passed', () => {
    assert.deepEqual(summary.flips, [
      {
        temperature: 'cold',
        round: 1,
        errors: [
          {
            package: '@scope/a',
            step: 'test',
            line: 'Error: heap out of memory',
          },
        ],
      },
    ]);
  });

  it('prints the table in seconds and quotes each flipped error', () => {
    const text = formatSummary(summary);

    assert.match(text, /^flipped rounds: 1$/m);
    assert.match(text, /^- cold r1 a test: Error: heap out of memory$/m);
    assert.match(
      text,
      /^\| cold \| serial \| 3 \| 3 \| 32\.00 \| 30\.00 \| 34\.00 \| 4\.00 \|$/m,
    );
  });
});

describe('verify-jobs.mjs end to end over a stub runner', () => {
  let base;
  let runner;

  before(() => {
    base = mkdtempSync(join(tmpdir(), 'verify-jobs-'));
    runner = join(base, 'stub-runner');
    writeFileSync(runner, PNPM_STAND_IN_FAILING_UNDER_CONTENTION);
    chmodSync(runner, 0o755);
  });

  after(() => rmSync(base, { recursive: true, force: true }));

  it('prints one line per round with arm, load, wall seconds, and every exit', () => {
    const root = makeWorkspace(base, 'lines');
    const json = join(base, 'lines.json');

    const result = runProbe(root, runner, ['--rounds', '1', '--json', json]);

    assert.equal(result.status, 0, result.stderr);
    const rowLines = result.stdout
      .split('\n')
      .filter((line) => /^(cold|warm) (r\d+|prime) /.test(line));
    assert.equal(rowLines.length, 5);
    const malformed = rowLines.filter(
      (line) =>
        !/^(cold|warm) (r1|prime) (serial|concurrent) load=\d+\.\d{2} wall=\d+\.\d{2}s exits=a:0,b:0,c:0$/.test(
          line,
        ),
    );
    assert.deepEqual(malformed, []);
    assert.match(result.stdout, /^flipped rounds: 0$/m);
    const record = JSON.parse(readFileSync(json, 'utf8'));
    const warmValidity = record.rows
      .filter((row) => row.temperature === 'warm')
      .map((row) => row.isWarmValid);
    assert.deepEqual(warmValidity, [true, true, true]);
  });

  it('runs the serial arm one job at a time and the concurrent arm all at once', () => {
    const root = makeWorkspace(base, 'overlap');

    const result = runProbe(
      root,
      runner,
      ['--rounds', '1', '--temperatures', 'cold'],
      { STUB_SLEEP_MS: String(OVERLAP_SLEEP_MS) },
    );

    assert.equal(result.status, 0, result.stderr);
    const log = readLog(root).sort(
      (first, second) => first.start - second.start,
    );
    assert.equal(log.length, JOBS_PER_ROUND);
    const serial = log.slice(0, PACKAGE_NAMES.length);
    const concurrent = log.slice(PACKAGE_NAMES.length);
    const overlappingSerial = serial.filter(
      (entry, index) => index > 0 && entry.start < serial[index - 1].end,
    );
    assert.deepEqual(overlappingSerial, [], 'serial jobs overlapped');
    const firstEnd = Math.min(...concurrent.map((entry) => entry.end));
    const lateStarters = concurrent.filter((entry) => entry.start >= firstEnd);
    assert.deepEqual(lateStarters, [], 'concurrent jobs did not overlap');
  });

  it('clears .wireit before every cold round and keeps it for warm rounds', () => {
    const root = makeWorkspace(base, 'temperatures');

    const result = runProbe(root, runner, ['--rounds', '1']);

    assert.equal(result.status, 0, result.stderr);
    const log = readLog(root);
    assert.equal(log.length, JOBS_PER_ROUND + PACKAGE_NAMES.length * 3);
    const coldState = log
      .slice(0, JOBS_PER_ROUND)
      .map((entry) => entry.hadState);
    const warmState = log.slice(JOBS_PER_ROUND).map((entry) => entry.hadState);
    assert.ok(
      coldState.every((hadState) => hadState === false),
      `a cold job found state: ${coldState}`,
    );
    assert.ok(
      warmState.every((hadState) => hadState === true),
      `a warm job found no state: ${warmState}`,
    );
  });

  it('counts a round as flipped when only the concurrent arm fails, quoting the error', () => {
    const root = makeWorkspace(base, 'contend');

    const result = runProbe(
      root,
      runner,
      ['--rounds', '1', '--temperatures', 'cold'],
      { STUB_MODE: 'contend', STUB_SLEEP_MS: String(OVERLAP_SLEEP_MS) },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^cold r1 serial .* exits=a:0,b:0,c:0$/m);
    assert.match(result.stdout, /^cold r1 concurrent .* exits=.*:1/m);
    assert.match(result.stdout, /^flipped rounds: 1$/m);
    assert.match(
      result.stdout,
      /^- cold r1 [abc] check: Error: lock held by another job$/m,
    );
  });

  it('lists the plan and runs nothing on --dry-run', () => {
    const root = makeWorkspace(base, 'dry');

    const result = runProbe(root, runner, ['--rounds', '2', '--dry-run']);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^rounds 9 \(1 untimed\)$/m);
    assert.match(
      result.stdout,
      /^jobs .*stub-runner --filter a run check \| /m,
    );
    assert.equal(existsSync(join(root, 'log.jsonl')), false);
  });

  it('exits 2 naming a package the workspace does not hold', () => {
    const root = makeWorkspace(base, 'unknown');

    const result = runProbe(root, runner, ['--clear', 'zeta']);

    assert.equal(result.status, 2);
    assert.match(result.stderr, /--clear names no workspace package: zeta/);
  });
});
