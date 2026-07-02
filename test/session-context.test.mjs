import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeFixture, runCli, runScript, sh } from './fixtures.mjs';

const SCRIPT = '.claude/scripts/session-context.mjs';
const KIT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

test('S1: prints branch + changed files + touched targets; caps output', () => {
  const root = makeFixture('pnpm-monorepo');
  try {
    assert.equal(runCli(['init', '--yes', root]).status, 0);
    sh(root, 'git', ['add', '-A']);
    sh(root, 'git', ['commit', '-qm', 'install kit']);

    // Clean tree → just the branch line.
    let r = runScript(root, SCRIPT, { input: '{}' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /\[kit\] branch: main/);
    assert.ok(!r.stdout.includes('uncommitted'));

    appendFileSync(join(root, 'games/cityville/src/game.ts'), '// tweak\n');
    r = runScript(root, SCRIPT, { input: '{}' });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /uncommitted \(1\): games\/cityville\/src\/game\.ts/);
    assert.match(r.stdout, /targets touched: cityville/);
    assert.ok(r.stdout.split('\n').filter(Boolean).length <= 4, 'header must stay tiny');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('S2: repo with no commits yet does not crash', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kit-unborn-'));
  try {
    sh(dir, 'git', ['init', '-q']);
    const r = spawnSync(process.execPath, [join(KIT_ROOT, 'payload/scripts/session-context.mjs')], {
      cwd: dir,
      input: '{}',
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, r.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
