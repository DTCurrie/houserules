import { beforeEach, describe, expect, it } from 'vitest';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { useInstalledRepo } from '#test/repo';
import { runIn, runScript } from '#test/run';
import { kitConfigPath, readJson } from '#test/installed-tree';

const SCRIPT = '.claude/scripts/changeset-check.mjs';
const PLUGIN_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

function installChangesets(): string {
  return useInstalledRepo('pnpm-monorepo', {
    modules: 'cs/changesets',
    plugins: [{ name: PLUGIN_ROOT, alias: 'cs' }],
  });
}

describe('changeset-check.mjs', () => {
  let root: string;

  beforeEach(() => {
    root = installChangesets();
  });

  it('exits 2 naming the package and the fix flags when source changed with no changeset', () => {
    appendFileSync(
      join(root, 'games/cityville/src/game.ts'),
      'export const more = 2;\n',
    );
    const r = runScript(root, SCRIPT, { input: '{}' });
    expect(r.status, `expected nudge, got ${r.status}: ${r.stderr}`).toBe(2);
    expect(r.stderr).toMatch(/--pkg @fix\/cityville/);
    expect(r.stderr).toMatch(/--empty/);
  });

  it('stays silent once an untracked changeset covers the change', () => {
    appendFileSync(
      join(root, 'games/cityville/src/game.ts'),
      'export const more = 2;\n',
    );
    writeFileSync(
      join(root, '.changeset/kit-abc123.md'),
      '---\n"@fix/cityville": patch\n---\n\nMore.\n',
    );
    const r = runScript(root, SCRIPT, { input: '{}' });
    expect(r.status, r.stderr).toBe(0);
  });

  it('stays silent when the changeset was committed earlier on the branch and only later changes are dirty', () => {
    appendFileSync(
      join(root, 'games/cityville/src/game.ts'),
      'export const more = 2;\n',
    );
    writeFileSync(
      join(root, '.changeset/kit-abc123.md'),
      '---\n"@fix/cityville": patch\n---\n\nMore.\n',
    );
    runIn(root, 'git', ['checkout', '-qb', 'feature']);
    runIn(root, 'git', ['add', '-A']);
    runIn(root, 'git', ['commit', '-qm', 'feat: more, with changeset']);
    appendFileSync(
      join(root, 'apps/studio/src/main.ts'),
      'export const two = 2;\n',
    );
    const r = runScript(root, SCRIPT, { input: '{}' });
    expect(
      r.status,
      `branch-committed changeset should silence: ${r.stderr}`,
    ).toBe(0);
  });

  it('stays silent when only generated ledgers (BACKLOG.md/CHANGELOG.md) inside a target scope change', () => {
    writeFileSync(
      join(root, 'games/cityville/CHANGELOG.md'),
      '# Changelog\n\n- released a thing\n',
    );
    writeFileSync(
      join(root, 'games/cityville/BACKLOG.md'),
      '# Backlog\n\n- deferred a thing\n',
    );
    const r = runScript(root, SCRIPT, { input: '{}' });
    expect(r.status, `ledger-only churn must stay silent: ${r.stderr}`).toBe(0);
  });

  it('still nudges when a real source change lands alongside ledger churn', () => {
    writeFileSync(
      join(root, 'games/cityville/CHANGELOG.md'),
      '# Changelog\n\n- released a thing\n',
    );
    writeFileSync(
      join(root, 'games/cityville/BACKLOG.md'),
      '# Backlog\n\n- deferred a thing\n',
    );
    appendFileSync(
      join(root, 'games/cityville/src/game.ts'),
      'export const more = 2;\n',
    );
    const r = runScript(root, SCRIPT, { input: '{}' });
    expect(r.status, `real source change must still nudge: ${r.stderr}`).toBe(
      2,
    );
    expect(r.stderr).toMatch(/--pkg @fix\/cityville/);
  });

  it('suppresses a repeat nudge for the same changed-file signature, and nudges again once the signature changes', () => {
    appendFileSync(
      join(root, 'games/cityville/src/game.ts'),
      'export const more = 2;\n',
    );
    let r = runScript(root, SCRIPT, { input: '{}' });
    expect(r.status, `first nudge: ${r.stderr}`).toBe(2);

    r = runScript(root, SCRIPT, { input: '{}' });
    expect(r.status, `unchanged situation must stay silent: ${r.stderr}`).toBe(
      0,
    );

    appendFileSync(
      join(root, 'apps/studio/src/main.ts'),
      'export const two = 2;\n',
    );
    r = runScript(root, SCRIPT, { input: '{}' });
    expect(r.status, `new source file must nudge again: ${r.stderr}`).toBe(2);

    r = runScript(root, SCRIPT, { input: '{}' });
    expect(
      r.status,
      `newly-settled situation must stay silent: ${r.stderr}`,
    ).toBe(0);
  });

  it('never stages the suppression state file itself', () => {
    appendFileSync(
      join(root, 'games/cityville/src/game.ts'),
      'export const more = 2;\n',
    );
    const r = runScript(root, SCRIPT, { input: '{}' });
    expect(r.status, r.stderr).toBe(2);

    runIn(root, 'git', ['add', '-A']);
    const staged = runIn(root, 'git', [
      'diff',
      '--cached',
      '--name-only',
      '--',
      '.claude/state/changeset-check.json',
    ]);
    expect(staged.trim()).toBe('');
  });

  it('fails open to a nudge rather than crashing or silencing when the state file is corrupt or unwritable', () => {
    appendFileSync(
      join(root, 'games/cityville/src/game.ts'),
      'export const more = 2;\n',
    );
    mkdirSync(join(root, '.claude/state/changeset-check.json'), {
      recursive: true,
    });
    const r = runScript(root, SCRIPT, { input: '{}' });
    expect(
      r.status,
      `corrupt/unwritable state must fail open to a nudge: ${r.stderr}`,
    ).toBe(2);
  });

  it('exits 0 when stop_hook_active is set, short-circuiting the check', () => {
    appendFileSync(
      join(root, 'games/cityville/src/game.ts'),
      'export const more = 2;\n',
    );
    const r = runScript(root, SCRIPT, { input: '{"stop_hook_active":true}' });
    expect(r.status).toBe(0);
  });

  it('exits 0 when changesets.stopCheck is false', () => {
    appendFileSync(
      join(root, 'games/cityville/src/game.ts'),
      'export const more = 2;\n',
    );
    const configPath = kitConfigPath(root);
    const config = readJson<{
      changesets: { stopCheck: boolean; baseBranch: string };
    }>(configPath);
    config.changesets.stopCheck = false;
    writeFileSync(configPath, JSON.stringify(config, null, 2));
    const r = runScript(root, SCRIPT, { input: '{}' });
    expect(r.status).toBe(0);
  });

  it('falls back to worktree mode and still nudges when the configured base branch does not exist', () => {
    appendFileSync(
      join(root, 'games/cityville/src/game.ts'),
      'export const more = 2;\n',
    );
    const configPath = kitConfigPath(root);
    const config = readJson<{
      changesets: { stopCheck: boolean; baseBranch: string };
    }>(configPath);
    config.changesets.baseBranch = 'does-not-exist';
    writeFileSync(configPath, JSON.stringify(config, null, 2));
    const r = runScript(root, SCRIPT, { input: '{}' });
    expect(r.status, 'worktree fallback still nudges on dirty src').toBe(2);
  });
});

describe('changeset-check.mjs, non-target changes', () => {
  it('stays silent when only a non-target file (README.md) is dirty', () => {
    const root = installChangesets();
    runIn(root, 'git', ['add', '-A']);
    runIn(root, 'git', ['commit', '-qm', 'install kit']);
    appendFileSync(join(root, 'README.md'), 'docs only\n');
    const r = runScript(root, SCRIPT, { input: '{}' });
    expect(r.status, r.stderr).toBe(0);
  });
});
