import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const SCRIPT = new URL('../actions-plan.mjs', import.meta.url).pathname;
const REAL_FIXTURE = new URL('../fixtures/effort-stage-a', import.meta.url)
  .pathname;
const FIXTURE = 'scripts/eval/fixtures/effort-stage-a';

/** A temp root holding a copy of the real arm fixture and one bench file. */
function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'actions-plan-'));
  cpSync(REAL_FIXTURE, join(root, FIXTURE), { recursive: true });
  mkdirSync(join(root, 'scripts/bench/sub'), { recursive: true });
  writeFileSync(join(root, 'scripts/bench/run.mjs'), '');
  writeFileSync(join(root, 'scripts/bench/notes.txt'), '');
  writeFileSync(join(root, 'scripts/other.mjs'), '');
  return root;
}

const ROOT = makeRoot();

function plan(args) {
  const result = spawnSync(
    process.execPath,
    [SCRIPT, ...args, '--root', ROOT],
    {
      encoding: 'utf8',
    },
  );
  return { status: result.status, out: result.stdout, err: result.stderr };
}

function matrix(overrides = {}) {
  const flags = {
    fixture: FIXTURE,
    arms: 'high,medium',
    samples: '2',
    'per-run': '1',
    margin: '0.5',
    total: '6',
    ...overrides,
  };
  return plan([
    'matrix',
    ...Object.entries(flags).map(([key, value]) => `--${key}=${value}`),
  ]);
}

function refused(result, pattern) {
  assert.equal(result.status, 2);
  assert.match(result.err, pattern);
}

describe('actions-plan matrix', () => {
  it('prints the include list for two arms and two samples', () => {
    const result = matrix();
    assert.equal(result.status, 0);
    assert.equal(
      result.out,
      '{"include":[{"arm":"high","sample":1},{"arm":"high","sample":2},{"arm":"medium","sample":1},{"arm":"medium","sample":2}]}\n',
    );
  });

  it('passes with the worst case exactly at the total', () => {
    assert.equal(matrix({ total: '6' }).status, 0);
  });

  it('refuses a worst case one cent over the total, naming both', () => {
    const result = matrix({ total: '5.99' });
    refused(result, /worst case \$6\.0000 exceeds --total \$5\.99/);
  });

  it('refuses a fixture outside scripts/eval/fixtures', () => {
    refused(matrix({ fixture: 'scripts/bench' }), /not a directory under/);
    refused(matrix({ fixture: '../elsewhere' }), /not a directory under/);
  });

  it('refuses an arm the fixture does not hold', () => {
    refused(matrix({ arms: 'high,nope' }), /"nope" is not in/);
  });

  it('refuses a bad --samples', () => {
    for (const samples of ['0', '-1', '1.5', 'x']) {
      refused(matrix({ samples }), /--samples must be a positive integer/);
    }
  });

  it('refuses non-positive --per-run and --total', () => {
    for (const value of ['0', '-1', 'x']) {
      refused(matrix({ 'per-run': value }), /--per-run must be a positive/);
      refused(matrix({ total: value }), /--total must be a positive/);
    }
  });

  it('refuses a negative --margin and accepts zero', () => {
    refused(matrix({ margin: '-0.1' }), /--margin must be a non-negative/);
    assert.equal(matrix({ margin: '0', total: '4' }).status, 0);
  });

  it('refuses an empty arm list and a repeated arm', () => {
    refused(matrix({ arms: '' }), /empty arm/);
    refused(matrix({ arms: 'high,' }), /empty arm/);
    refused(matrix({ arms: 'high,high' }), /repeats "high"/);
  });

  it('refuses a missing flag', () => {
    refused(plan(['matrix']), /--fixture is required/);
  });
});

describe('actions-plan bench', () => {
  it('prints the root-relative path of a bench file', () => {
    const result = plan(['bench', '--path', 'scripts/bench/run.mjs']);
    assert.equal(result.status, 0);
    assert.equal(result.out, 'scripts/bench/run.mjs\n');
  });

  it('refuses a .. escape, an absolute path elsewhere, and the directory', () => {
    refused(
      plan(['bench', '--path', 'scripts/bench/../other.mjs']),
      /not a \.mjs file under/,
    );
    refused(
      plan(['bench', '--path', join(ROOT, 'scripts/other.mjs')]),
      /not a \.mjs file under/,
    );
    refused(
      plan(['bench', '--path', 'scripts/bench']),
      /not a \.mjs file under/,
    );
  });

  it('refuses a non-.mjs file and a missing file', () => {
    refused(
      plan(['bench', '--path', 'scripts/bench/notes.txt']),
      /not a \.mjs file under/,
    );
    refused(
      plan(['bench', '--path', 'scripts/bench/missing.mjs']),
      /not an existing file/,
    );
    refused(
      plan(['bench', '--path', 'scripts/bench/sub.mjs']),
      /not an existing file/,
    );
  });
});

describe('actions-plan usage', () => {
  it('refuses an unknown subcommand', () => {
    refused(plan(['frob']), /unknown subcommand "frob"/);
  });
});
