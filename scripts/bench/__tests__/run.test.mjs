import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { measureCase as realMeasureCase, CaseError } from '../timing.mjs';
import { parseOptions, runBench, runProfile } from '../run.mjs';
import { GATE } from '../stats.mjs';

const RUN_PATH = fileURLToPath(new URL('../run.mjs', import.meta.url));
const CLI_SPAWN_TIMEOUT_MS = 120_000;
const FAKE_COMMIT = 'a'.repeat(40);
const NOISY_SAMPLES_MS = [10, 10, 10, 10, 10, 20, 30, 40, 50, 60];
const scratch = mkdtempSync(join(tmpdir(), 'bench-run-test-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

function fakeCase(name, script = 'process.exit(0)') {
  return {
    name,
    command: process.execPath,
    args: ['-e', script],
    cwd: scratch,
  };
}

function fakeDeps(cases, overrides = {}) {
  return {
    ensureBuild: (rev) => ({
      commit: FAKE_COMMIT,
      root: scratch,
      cached: true,
      rev,
    }),
    SUITES: { fake: async () => ({ cases: async () => cases }) },
    repoDir: scratch,
    log: () => {},
    ...overrides,
  };
}

function options(name, extra = {}) {
  return {
    suite: 'fake',
    out: join(scratch, name, 'result.json'),
    commit: 'HEAD',
    isSmoke: true,
    runs: 3,
    warmup: 1,
    ...extra,
  };
}

describe('runBench', () => {
  it('writes schema-shaped JSON in smoke mode and exits 0', async () => {
    const lines = [];
    const smoke = options('smoke');
    const code = await runBench(
      smoke,
      fakeDeps([fakeCase('one'), fakeCase('two')], {
        log: (line) => lines.push(line),
      }),
    );
    const result = JSON.parse(readFileSync(smoke.out, 'utf8'));
    assert.equal(code, 0);
    assert.deepEqual(Object.keys(result), [
      'schemaVersion',
      'createdAt',
      'mode',
      'requested',
      'machine',
      'build',
      'settings',
      'gate',
      'cases',
      'verdict',
    ]);
    assert.equal(result.schemaVersion, 1);
    assert.equal(result.mode, 'smoke');
    assert.equal(result.requested, 'HEAD');
    assert.equal(result.machine.commit, FAKE_COMMIT);
    assert.deepEqual(result.build, { root: scratch, cached: true });
    assert.deepEqual(result.settings, { warmup: 1, runs: 3 });
    assert.deepEqual(result.gate, {
      statistic: 'relMad',
      threshold: GATE.threshold,
      minSamples: GATE.minSamples,
    });
    assert.deepEqual(
      result.cases.map((entry) => entry.id),
      ['fake/one', 'fake/two'],
    );
    assert.deepEqual(
      result.cases.map((entry) => [
        entry.samplesMs.length,
        entry.stats.n,
        entry.gate,
      ]),
      [
        [3, 3, 'insufficient'],
        [3, 3, 'insufficient'],
      ],
    );
    assert.equal(result.verdict, 'pass');
    assert.equal(lines.length, 2);
    assert.match(lines[0], /^fake\/one /);
  });

  it('exits 1 and still writes JSON when a case fails the gate', async () => {
    const failing = options('fail', {
      isSmoke: false,
      runs: GATE.minSamples,
      warmup: 0,
    });
    const code = await runBench(
      failing,
      fakeDeps([fakeCase('noisy')], {
        measureCase: () => ({ samplesMs: NOISY_SAMPLES_MS }),
      }),
    );
    const result = JSON.parse(readFileSync(failing.out, 'utf8'));
    assert.equal(code, 1);
    assert.equal(result.mode, 'full');
    assert.equal(result.cases[0].gate, 'fail');
    assert.equal(result.verdict, 'fail');
  });

  it('throws a CaseError and writes no JSON when a case exits unexpectedly', async () => {
    const broken = options('broken');
    await assert.rejects(
      runBench(
        broken,
        fakeDeps([fakeCase('bad', 'process.exit(3)')], {
          measureCase: realMeasureCase,
        }),
      ),
      CaseError,
    );
    assert.equal(existsSync(broken.out), false);
  });

  it('throws on an unknown suite', async () => {
    await assert.rejects(
      runBench(options('unknown', { suite: 'nope' }), fakeDeps([])),
      /unknown suite "nope"/,
    );
  });
});

describe('parseOptions', () => {
  it('applies smoke and full defaults', () => {
    const smoke = parseOptions(['--out', 'x.json', '--smoke']);
    assert.deepEqual([smoke.runs, smoke.warmup], [3, 1]);
    const full = parseOptions(['--out', 'x.json']);
    assert.deepEqual([full.runs, full.warmup, full.suite], [20, 3, 'all']);
  });

  it('rejects a missing out and a bad number', () => {
    assert.throws(() => parseOptions([]), /--out is required/);
    assert.throws(
      () => parseOptions(['--out', 'x', '--runs', 'abc']),
      /--runs/,
    );
  });
});

describe('run.mjs as a process', () => {
  it('exits 2 with a message when --out is missing', () => {
    const result = spawnSync(process.execPath, [RUN_PATH, '--smoke'], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /--out is required/);
  });

  it('exits 2 on an unknown suite', () => {
    const out = join(scratch, 'proc', 'result.json');
    const result = spawnSync(
      process.execPath,
      [RUN_PATH, '--suite', 'nope', '--out', out],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 2);
    assert.equal(existsSync(out), false);
  });
});

describe('--profile', () => {
  it('parses the profile flags with their defaults and no --out', () => {
    const parsed = parseOptions(['--profile', 'hooks/guard-bash']);
    assert.equal(parsed.profile, 'hooks/guard-bash');
    assert.equal(parsed.out, undefined);
    assert.equal(parsed.runs, 5);
    assert.equal(parsed.top, 20);
    assert.equal(parsed.interval, 100);
  });

  it('exits 2 from the CLI and lists the valid ids for an unknown case', () => {
    const result = spawnSync(
      process.execPath,
      [RUN_PATH, '--profile', 'nonesuch/none'],
      { encoding: 'utf8', timeout: CLI_SPAWN_TIMEOUT_MS },
    );
    assert.equal(result.status, 2);
    assert.match(
      result.stderr,
      /unknown case "nonesuch\/none", expected one of /,
    );
    assert.match(result.stderr, /hooks\//);
  });

  it('throws naming the valid ids when the case name is unknown', async () => {
    await assert.rejects(
      runProfile(
        { profile: 'fake/two', commit: 'HEAD', runs: 1, top: 1, interval: 100 },
        fakeDeps([fakeCase('one')]),
      ),
      /unknown case "fake\/two", expected one of fake\/one/,
    );
  });

  it('prints the profile JSON and writes --out when given', async () => {
    const lines = [];
    const out = join(scratch, 'profile', 'result.json');
    const code = await runProfile(
      {
        profile: 'fake/one',
        out,
        commit: 'HEAD',
        runs: 1,
        top: 1,
        interval: 100,
      },
      fakeDeps([fakeCase('one')], {
        log: (line) => lines.push(line),
        profileCase: (benchCase, opts) => ({
          case: opts.id,
          name: benchCase.name,
        }),
      }),
    );
    assert.equal(code, 0);
    assert.deepEqual(JSON.parse(lines.join('\n')), {
      case: 'fake/one',
      name: 'one',
    });
    assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')), {
      case: 'fake/one',
      name: 'one',
    });
  });
});
