import { expect, test } from 'vitest';
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeFixture, runCli, runScript, sh } from './fixtures.js';

const SCRIPT = '.claude/scripts/session-context.mjs';
const KIT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

test('S1: prints branch + changed files + touched targets; caps output', () => {
  const root = makeFixture('pnpm-monorepo');
  try {
    expect(runCli(['init', '--yes', root]).status).toBe(0);
    sh(root, 'git', ['add', '-A']);
    sh(root, 'git', ['commit', '-qm', 'install kit']);

    // Clean tree → just the branch line.
    let r = runScript(root, SCRIPT, { input: '{}' });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/\[kit\] branch: main/);
    expect(!r.stdout.includes('uncommitted')).toBeTruthy();

    appendFileSync(join(root, 'games/cityville/src/game.ts'), '// tweak\n');
    r = runScript(root, SCRIPT, { input: '{}' });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(
      /uncommitted \(1\): games\/cityville\/src\/game\.ts/,
    );
    expect(r.stdout).toMatch(/targets touched: cityville/);
    expect(
      r.stdout.split('\n').filter(Boolean).length <= 4,
      'header must stay tiny',
    ).toBeTruthy();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('S2: repo with no commits yet does not crash', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kit-unborn-'));
  try {
    sh(dir, 'git', ['init', '-q']);
    const r = spawnSync(
      process.execPath,
      [join(KIT_ROOT, 'payload-dist/scripts/session-context.mjs')],
      {
        cwd: dir,
        input: '{}',
        encoding: 'utf8',
      },
    );
    expect(r.status, r.stderr).toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
