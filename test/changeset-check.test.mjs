import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { makeFixture, runCli, runScript, sh } from './fixtures.mjs';

const SCRIPT = '.claude/scripts/changeset-check.mjs';

function installedFixture() {
  const root = makeFixture('pnpm-monorepo');
  assert.equal(runCli(['init', '--yes', root]).status, 0);
  return root;
}

test('CC1: dirty package source with no changeset → exit 2 naming the package', () => {
  const root = installedFixture();
  try {
    appendFileSync(
      join(root, 'games/cityville/src/game.ts'),
      'export const more = 2;\n',
    );
    const r = runScript(root, SCRIPT, { input: '{}' });
    assert.equal(r.status, 2, `expected nudge, got ${r.status}: ${r.stderr}`);
    assert.match(r.stderr, /--pkg @fix\/cityville/);
    assert.match(r.stderr, /--empty/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CC2: an untracked changeset silences the nudge; so does one committed on the branch', () => {
  const root = installedFixture();
  try {
    appendFileSync(
      join(root, 'games/cityville/src/game.ts'),
      'export const more = 2;\n',
    );
    writeFileSync(
      join(root, '.changeset/kit-abc123.md'),
      '---\n"@fix/cityville": patch\n---\n\nMore.\n',
    );
    let r = runScript(root, SCRIPT, { input: '{}' });
    assert.equal(r.status, 0, r.stderr);

    // Branch case: changeset COMMITTED earlier on the branch, new dirty src later.
    sh(root, 'git', ['checkout', '-qb', 'feature']);
    sh(root, 'git', ['add', '-A']);
    sh(root, 'git', ['commit', '-qm', 'feat: more, with changeset']);
    appendFileSync(
      join(root, 'apps/studio/src/main.ts'),
      'export const two = 2;\n',
    );
    r = runScript(root, SCRIPT, { input: '{}' });
    assert.equal(
      r.status,
      0,
      `branch-committed changeset should silence: ${r.stderr}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CC3: kill-switches and fallbacks — stop_hook_active, stopCheck:false, non-target change, bad base', () => {
  const root = installedFixture();
  try {
    appendFileSync(
      join(root, 'games/cityville/src/game.ts'),
      'export const more = 2;\n',
    );

    // stop_hook_active short-circuits.
    let r = runScript(root, SCRIPT, { input: '{"stop_hook_active":true}' });
    assert.equal(r.status, 0);

    // stopCheck kill-switch.
    const configPath = join(root, '.claude/kit.config.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    config.changesets.stopCheck = false;
    writeFileSync(configPath, JSON.stringify(config, null, 2));
    r = runScript(root, SCRIPT, { input: '{}' });
    assert.equal(r.status, 0);

    // Restore; missing base branch must fall back to worktree mode, not crash.
    config.changesets.stopCheck = true;
    config.changesets.baseBranch = 'does-not-exist';
    writeFileSync(configPath, JSON.stringify(config, null, 2));
    r = runScript(root, SCRIPT, { input: '{}' });
    assert.equal(r.status, 2, 'worktree fallback still nudges on dirty src');

    // Non-target change only → silent. (Fresh fixture: only README dirty.)
    const clean = makeFixture('pnpm-monorepo');
    try {
      assert.equal(runCli(['init', '--yes', clean]).status, 0);
      sh(clean, 'git', ['add', '-A']); // commit kit install so the tree is clean
      sh(clean, 'git', ['commit', '-qm', 'install kit']);
      appendFileSync(join(clean, 'README.md'), 'docs only\n');
      const r2 = runScript(clean, SCRIPT, { input: '{}' });
      assert.equal(r2.status, 0, r2.stderr);
    } finally {
      rmSync(clean, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
