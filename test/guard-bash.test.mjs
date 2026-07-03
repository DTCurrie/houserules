import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeFixture, runCli, runScript } from './fixtures.mjs';

const SCRIPT = '.claude/scripts/guard-bash.mjs';
const KIT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const payload = (command) => JSON.stringify({ tool_input: { command } });

function withConfig(root, guard) {
  mkdirSync(join(root, '.claude'), { recursive: true });
  writeFileSync(
    join(root, '.claude/kit.config.json'),
    JSON.stringify({ version: 2, guard, targets: [] }),
  );
}

test('G1: defaults block commit/push/stash/pr-create; benign commands pass; no config needed', () => {
  const root = makeFixture('pnpm-monorepo');
  try {
    assert.equal(runCli(['init', '--yes', root]).status, 0);
    for (const cmd of [
      'git commit -m x',
      'git push origin main',
      'git -C /x push',
      'git stash',
      'gh pr create --fill',
    ]) {
      const r = runScript(root, SCRIPT, { input: payload(cmd) });
      assert.equal(r.status, 2, `should block: ${cmd}`);
      assert.match(r.stderr, /Blocked by claude-kit guard/);
    }
    for (const cmd of [
      'ls -la',
      'git status',
      'git log --oneline',
      'pnpm run build',
    ]) {
      assert.equal(
        runScript(root, SCRIPT, { input: payload(cmd) }).status,
        0,
        `should allow: ${cmd}`,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  // No kit.config.json at all (payload script run directly) → hardcoded defaults.
  const bare = makeFixture('non-js');
  try {
    const r = spawnSync(
      process.execPath,
      [join(KIT_ROOT, 'payload/scripts/guard-bash.mjs')],
      {
        cwd: bare,
        input: payload('git commit -m x'),
        encoding: 'utf8',
      },
    );
    assert.equal(r.status, 2, 'defaults must apply without config');
  } finally {
    rmSync(bare, { recursive: true, force: true });
  }
});

test('G2: config toggles rules, custom rules fire, invalid regex skipped, garbage stdin passes', () => {
  const root = makeFixture('pnpm-monorepo');
  try {
    assert.equal(runCli(['init', '--yes', root]).status, 0);

    withConfig(root, { gitStash: false });
    assert.equal(
      runScript(root, SCRIPT, { input: payload('git stash') }).status,
      0,
      'gitStash:false allows',
    );
    assert.equal(
      runScript(root, SCRIPT, { input: payload('git commit -m x') }).status,
      2,
      'other defaults stay on',
    );

    withConfig(root, {
      custom: [
        { pattern: '\\bdocker\\s+system\\s+prune\\b', message: 'ask first' },
      ],
    });
    const r = runScript(root, SCRIPT, {
      input: payload('docker system prune -f'),
    });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /ask first/);

    withConfig(root, { custom: [{ pattern: '(unclosed' }] });
    assert.equal(
      runScript(root, SCRIPT, { input: payload('ls') }).status,
      0,
      'invalid regex must not break Bash',
    );

    assert.equal(
      runScript(root, SCRIPT, { input: 'not json at all' }).status,
      0,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
