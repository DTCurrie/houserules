import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { ensureNewestBuild } from '../build.mjs';
import { cases } from '../suites/scripts.mjs';

const REPO_DIR = resolve(
  fileURLToPath(import.meta.url),
  '..',
  '..',
  '..',
  '..',
);
const BUILD = ensureNewestBuild('HEAD', { repoDir: REPO_DIR });

const EXPECTED_NAMES = [
  'plan-lint',
  'prose-lint',
  'closeout',
  'verify-changed',
  'changeset-write',
];
const RUNS_PER_CASE = 2;
const DEFAULT_CASE_TIMEOUT_MS = 60000;
const NANOSECONDS_PER_MILLISECOND = 1e6;

const workDirs = [];
after(() => {
  for (const dir of workDirs) rmSync(dir, { recursive: true, force: true });
});

function freshWorkDir() {
  const dir = mkdtempSync(join(tmpdir(), 'scripts-suite-'));
  workDirs.push(dir);
  return dir;
}

function runCase(benchCase) {
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

describe('scripts suite', () => {
  it('returns the five cases, each over fixtures under workDir', async () => {
    const workDir = freshWorkDir();
    const list = await cases({ root: BUILD.root, repoDir: REPO_DIR, workDir });
    assert.deepEqual(
      list.map((benchCase) => benchCase.name),
      EXPECTED_NAMES,
    );
    for (const benchCase of list)
      assert.ok(
        benchCase.cwd.startsWith(workDir + sep),
        `${benchCase.name} cwd ${benchCase.cwd} is outside workDir`,
      );
  });

  it('runs every case to an expected status twice in a row', async () => {
    const workDir = freshWorkDir();
    const list = await cases({ root: BUILD.root, repoDir: REPO_DIR, workDir });
    const outputs = new Map();
    for (const benchCase of list) {
      const expected = benchCase.expectExit ?? [0];
      for (let run = 1; run <= RUNS_PER_CASE; run += 1) {
        const result = runCase(benchCase);
        assert.ok(
          expected.includes(result.status),
          `${benchCase.name} run ${run} exited ${result.status}, expected ${expected}: ${result.stderr}${result.stdout}`,
        );
        outputs.set(benchCase.name, result.stdout);
        console.log(
          `${benchCase.name} expectExit=${JSON.stringify(expected)} status=${result.status} wall=${result.wallMs.toFixed(1)}ms`,
        );
      }
    }

    assert.match(
      outputs.get('plan-lint'),
      /phase-2-http-api\.md +ERROR +\[plan-lint\/slice-status-vocabulary\] +slice 2b status "WAITING"/,
    );
    assert.match(
      outputs.get('prose-lint'),
      /guide\.md:\d+ +ERROR +\[prose-voice\/no-semicolons\]/,
    );
    assert.match(outputs.get('prose-lint'), /British spelling "normalises"/);
    assert.match(outputs.get('closeout'), /## Phase 2: http-api/);
    assert.match(outputs.get('verify-changed'), /@bench\/alpha: PASS/);
    assert.doesNotMatch(outputs.get('verify-changed'), /@bench\/beta/);
    const written = outputs.get('changeset-write').trim();
    assert.match(written, /^\.changeset\/[\w-]+\.md$/);
    const changesetFile = join(workDir, 'widget', written);
    assert.ok(existsSync(changesetFile), `${written} was not written`);
    assert.match(
      readFileSync(changesetFile, 'utf8'),
      /"@bench\/widget": minor/,
    );
  });
});
