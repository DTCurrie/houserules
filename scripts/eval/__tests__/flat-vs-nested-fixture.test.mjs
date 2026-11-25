import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'flat-vs-nested',
);
const NESTED_OVERLAY = join(
  'overlay',
  'skills',
  'orchestrate',
  'references',
  'nested.md',
);
const SIZING_MARKER = '**Size before the spawn.**';
const temps = [];

function envOutsideParentRun() {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

function armFile(arm, relative) {
  return readFileSync(join(FIXTURE, 'arms', arm, relative), 'utf8');
}

function scoreSelftest() {
  const out = mkdtempSync(join(tmpdir(), 'hr-flat-vs-nested-score-'));
  temps.push(out);
  const built = spawnSync(
    process.execPath,
    [join(FIXTURE, 'make-selftest.mjs'), out],
    { encoding: 'utf8' },
  );
  assert.equal(built.status, 0, built.stderr);
  const scored = spawnSync(
    process.execPath,
    [join(FIXTURE, 'score.mjs'), out],
    {
      env: envOutsideParentRun(),
      encoding: 'utf8',
    },
  );
  assert.equal(scored.status, 0, scored.stderr);
  const rows = scored.stdout
    .split('\n')
    .filter((line) => line.startsWith('JSON '))
    .map((line) => JSON.parse(line.slice('JSON '.length)));
  return {
    rows: Object.fromEntries(
      rows.map((row) => [`${row.arm}-${row.sample}`, row]),
    ),
    summaries: scored.stdout
      .split('\n')
      .filter((line) => line.startsWith('summary ')),
  };
}

describe('flat-vs-nested fixture', () => {
  after(() => {
    for (const root of temps) rmSync(root, { recursive: true, force: true });
  });

  it('gives each arm its exact prompt', () => {
    assert.deepEqual(
      ['nested', 'sized', 'flat'].map((arm) => armFile(arm, 'prompt.txt')),
      [
        '/orchestrate eval-fixture all --auto',
        '/orchestrate eval-fixture all --auto',
        '/orchestrate eval-fixture all --auto --flat',
      ],
    );
  });

  it('removes the sizing step from the nested overlay and keeps it in the sized overlay', () => {
    assert.equal(
      armFile('nested', NESTED_OVERLAY).includes(SIZING_MARKER),
      false,
    );
    assert.equal(
      armFile('sized', NESTED_OVERLAY).includes(SIZING_MARKER),
      true,
    );
  });

  describe('score.mjs on the recorded selftest samples', () => {
    it('scores the valid nested sample with one revise and not the orchestrator continue', () => {
      const { rows } = scoreSelftest();

      assert.deepEqual(
        {
          valid: rows['nested-1'].valid,
          cause: rows['nested-1'].cause,
          cost: rows['nested-1'].cost,
          wallSeconds: rows['nested-1'].wallSeconds,
          maxGapSeconds: rows['nested-1'].maxGapSeconds,
          revises: rows['nested-1'].revises,
          workers: rows['nested-1'].workers,
          orchestrators: rows['nested-1'].orchestrators,
          phasesDone: rows['nested-1'].phasesDone,
          acceptance: rows['nested-1'].acceptance,
        },
        {
          valid: true,
          cause: null,
          cost: 1.5,
          wallSeconds: 300,
          maxGapSeconds: 110,
          revises: 1,
          workers: 2,
          orchestrators: 2,
          phasesDone: 2,
          acceptance: 'PASS',
        },
      );
    });

    it('scores the valid flat sample with no orchestrators and no revise', () => {
      const { rows } = scoreSelftest();

      assert.deepEqual(
        {
          valid: rows['flat-1'].valid,
          cost: rows['flat-1'].cost,
          wallSeconds: rows['flat-1'].wallSeconds,
          maxGapSeconds: rows['flat-1'].maxGapSeconds,
          revises: rows['flat-1'].revises,
          workers: rows['flat-1'].workers,
          orchestrators: rows['flat-1'].orchestrators,
          acceptance: rows['flat-1'].acceptance,
        },
        {
          valid: true,
          cost: 1.0,
          wallSeconds: 180,
          maxGapSeconds: 60,
          revises: 0,
          workers: 2,
          orchestrators: 0,
          acceptance: 'PASS',
        },
      );
    });

    it('counts a revise to a worker whose only report is a completed task-notification', () => {
      const { rows } = scoreSelftest();

      assert.deepEqual(
        [rows['flat-2'].valid, rows['flat-2'].revises, rows['flat-2'].workers],
        [true, 1, 1],
      );
    });

    it('marks a sample with a gap over 600 seconds invalid with a rerun cause', () => {
      const { rows } = scoreSelftest();

      assert.deepEqual(
        [
          rows['sized-2'].valid,
          rows['sized-2'].cause,
          rows['sized-2'].acceptance,
        ],
        [false, 'gap 680s over 600s, rerun', 'PASS'],
      );
    });

    it('names the failing leaf tests when the acceptance fails on the plain repo source', () => {
      const { rows } = scoreSelftest();

      assert.equal(rows['nested-2'].valid, false);
      assert.equal(rows['nested-2'].acceptance, 'FAIL');
      assert.match(rows['nested-2'].cause, /^acceptance failed: .+/);
    });

    it('marks a sample that stopped at a ruling invalid, never a cheap success', () => {
      const { rows } = scoreSelftest();

      assert.deepEqual(
        [
          rows['sized-1'].valid,
          rows['sized-1'].cause,
          rows['sized-1'].phasesDone,
        ],
        [false, 'stopped at a ruling', 1],
      );
    });

    it('leaves invalid samples out of the arm means', () => {
      const { summaries } = scoreSelftest();

      assert.deepEqual(summaries, [
        'summary flat\tvalid=2\tinvalid=0\tcost=0.9 (0.8-1)\twall=165 (150-180)\trevises=0.5 (0-1)',
        'summary nested\tvalid=1\tinvalid=1\tcost=1.5 (1.5-1.5)\twall=300 (300-300)\trevises=1 (1-1)',
        'summary sized\tvalid=0\tinvalid=2\tcost=-\twall=-\trevises=-',
      ]);
    });
  });
});
