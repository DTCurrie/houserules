import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { ensureNewestBuild } from '../build.mjs';
import { cases } from '../suites/cli.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const BUILD = ensureNewestBuild('HEAD', { repoDir: REPO });

const RUNS_PER_CASE = 2;
const DEFAULT_CASE_TIMEOUT_MS = 60000;
const NANOSECONDS_PER_MILLISECOND = 1e6;

const REPORT_SESSION_LINE = 'sessions: 2,';
const REPORT_FRESH_INPUT = 'fresh input 2,400';
const UPDATE_NOOP_LINE = 'Nothing written — already up to date.';

function runOnce(benchCase) {
  benchCase.beforeEach?.();
  const started = process.hrtime.bigint();
  const result = spawnSync(benchCase.command, benchCase.args, {
    cwd: benchCase.cwd,
    env: { ...process.env, ...benchCase.env },
    input: benchCase.stdin,
    encoding: 'utf8',
    timeout: benchCase.timeoutMs ?? DEFAULT_CASE_TIMEOUT_MS,
  });
  const wallMs =
    Number(process.hrtime.bigint() - started) / NANOSECONDS_PER_MILLISECOND;
  return { ...result, wallMs };
}

describe('cli suite', () => {
  let workDir;
  let suite;

  before(async () => {
    workDir = mkdtempSync(join(tmpdir(), 'bench-cli-test-'));
    suite = await cases({ root: BUILD.root, repoDir: REPO, workDir });
  });

  after(() => {
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  });

  const byName = (name) => suite.find((benchCase) => benchCase.name === name);

  it('returns init, update-noop, doctor, and report, each under workDir', () => {
    assert.deepEqual(
      suite.map((benchCase) => benchCase.name),
      ['init', 'update-noop', 'doctor', 'report'],
    );
    for (const benchCase of suite)
      assert.ok(
        benchCase.cwd.startsWith(realpathSync(workDir)),
        `${benchCase.name} runs in ${benchCase.cwd}, outside ${workDir}`,
      );
  });

  it('runs every case to an expected status twice in a row', () => {
    for (const benchCase of suite) {
      const expected = benchCase.expectExit ?? [0];
      for (let run = 1; run <= RUNS_PER_CASE; run += 1) {
        const result = runOnce(benchCase);
        assert.ok(
          expected.includes(result.status),
          `${benchCase.name} run ${run} exited ${result.status}, expected ${expected}: ${result.stdout}${result.stderr}`,
        );
        console.log(
          `  ${benchCase.name} run ${run}: expectExit ${JSON.stringify(expected)}, status ${result.status}, ${result.wallMs.toFixed(0)} ms`,
        );
      }
    }
  });

  it('init installs from scratch on every run', () => {
    const initCase = byName('init');
    for (let run = 1; run <= RUNS_PER_CASE; run += 1)
      assert.match(
        runOnce(initCase).stdout,
        /Wrote [1-9]\d* files/,
        `run ${run} must write a fresh install. The count follows the payload, which the bench does not own.`,
      );
  });

  it('update-noop finds nothing to write', () => {
    const { stdout } = runOnce(byName('update-noop'));
    assert.ok(stdout.includes(UPDATE_NOOP_LINE), stdout);
  });

  it('report reads the fixture transcripts, not ~/.claude', () => {
    const { stdout } = runOnce(byName('report'));
    assert.ok(
      stdout.includes(REPORT_SESSION_LINE),
      `expected the fixture's two sessions, not the real ~/.claude:\n${stdout}`,
    );
    assert.ok(
      stdout.includes(REPORT_FRESH_INPUT),
      `expected the fixture's 2,400 fresh input tokens, not the real ~/.claude:\n${stdout}`,
    );
  });
});
