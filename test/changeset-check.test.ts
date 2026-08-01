import { expect, test } from 'vitest';
import { appendFileSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { makeFixture, runCli, runScript, sh } from './fixtures.js';

const SCRIPT = '.claude/scripts/changeset-check.mjs';

function installedFixture(): string {
  const root = makeFixture('pnpm-monorepo');
  expect(runCli(['init', '--yes', root]).status).toBe(0);
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
    expect(r.status, `expected nudge, got ${r.status}: ${r.stderr}`).toBe(2);
    expect(r.stderr).toMatch(/--pkg @fix\/cityville/);
    expect(r.stderr).toMatch(/--empty/);
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
    expect(r.status, r.stderr).toBe(0);

    // Branch case: changeset COMMITTED earlier on the branch, new dirty src later.
    sh(root, 'git', ['checkout', '-qb', 'feature']);
    sh(root, 'git', ['add', '-A']);
    sh(root, 'git', ['commit', '-qm', 'feat: more, with changeset']);
    appendFileSync(
      join(root, 'apps/studio/src/main.ts'),
      'export const two = 2;\n',
    );
    r = runScript(root, SCRIPT, { input: '{}' });
    expect(
      r.status,
      `branch-committed changeset should silence: ${r.stderr}`,
    ).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CC4: generated ledgers in scope (BACKLOG.md/CHANGELOG.md) do not trip the nudge', () => {
  const root = installedFixture();
  try {
    // Both match the cityville target scope (games/cityville/) but are generated churn.
    writeFileSync(
      join(root, 'games/cityville/CHANGELOG.md'),
      '# Changelog\n\n- released a thing\n',
    );
    writeFileSync(
      join(root, 'games/cityville/BACKLOG.md'),
      '# Backlog\n\n- deferred a thing\n',
    );
    let r = runScript(root, SCRIPT, { input: '{}' });
    expect(r.status, `ledger-only churn must stay silent: ${r.stderr}`).toBe(0);

    // A real source change alongside the ledgers must still nudge.
    appendFileSync(
      join(root, 'games/cityville/src/game.ts'),
      'export const more = 2;\n',
    );
    r = runScript(root, SCRIPT, { input: '{}' });
    expect(r.status, `real source change must still nudge: ${r.stderr}`).toBe(
      2,
    );
    expect(r.stderr).toMatch(/--pkg @fix\/cityville/);
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
    expect(r.status).toBe(0);

    // stopCheck kill-switch.
    const configPath = join(root, '.claude/kit.config.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
      changesets: { stopCheck: boolean; baseBranch: string };
    };
    config.changesets.stopCheck = false;
    writeFileSync(configPath, JSON.stringify(config, null, 2));
    r = runScript(root, SCRIPT, { input: '{}' });
    expect(r.status).toBe(0);

    // Restore; missing base branch must fall back to worktree mode, not crash.
    config.changesets.stopCheck = true;
    config.changesets.baseBranch = 'does-not-exist';
    writeFileSync(configPath, JSON.stringify(config, null, 2));
    r = runScript(root, SCRIPT, { input: '{}' });
    expect(r.status, 'worktree fallback still nudges on dirty src').toBe(2);

    // Non-target change only → silent. (Fresh fixture: only README dirty.)
    const clean = makeFixture('pnpm-monorepo');
    try {
      expect(runCli(['init', '--yes', clean]).status).toBe(0);
      sh(clean, 'git', ['add', '-A']); // commit kit install so the tree is clean
      sh(clean, 'git', ['commit', '-qm', 'install kit']);
      appendFileSync(join(clean, 'README.md'), 'docs only\n');
      const r2 = runScript(clean, SCRIPT, { input: '{}' });
      expect(r2.status, r2.stderr).toBe(0);
    } finally {
      rmSync(clean, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
