import { expect, test } from 'vitest';
import {
  appendFileSync,
  existsSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { makeFixture, runCli, sh } from './fixtures.js';

test('U1: update keeps local edits, --force overwrites, stale files refresh', () => {
  const root = makeFixture('pnpm-monorepo');
  try {
    expect(runCli(['init', '--yes', root]).status).toBe(0);

    // Local edit → update must keep it.
    const guardPath = join(root, '.claude/scripts/guard-bash.mjs');
    appendFileSync(guardPath, '// my local tweak\n');
    const edited = readFileSync(guardPath, 'utf8');
    let r = runCli(['update', root]);
    expect(r.status, r.stderr).toBe(0);
    expect(
      readFileSync(guardPath, 'utf8'),
      'local edit clobbered without --force',
    ).toBe(edited);

    // --force → kit version restored.
    r = runCli(['update', '--force', root]);
    expect(r.status, r.stderr).toBe(0);
    expect(
      readFileSync(guardPath, 'utf8').includes('my local tweak'),
    ).toBeFalsy();

    // Stale kit file (manifest hash matches disk, kit has newer content) → refreshed.
    const lintPath = join(root, '.claude/scripts/lint-format-fix.mjs');
    writeFileSync(lintPath, '// OLD KIT VERSION\n');
    const manifestPath = join(root, '.claude/kit-manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      files: Record<string, string>;
    };
    manifest.files['.claude/scripts/lint-format-fix.mjs'] = createHash('sha256')
      .update('// OLD KIT VERSION\n')
      .digest('hex');
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    r = runCli(['update', root]);
    expect(r.status, r.stderr).toBe(0);
    expect(
      readFileSync(lintPath, 'utf8').includes('Stop / SubagentStop hook'),
      'stale file not refreshed',
    ).toBeTruthy();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('U3: update untracks reference templates committed before they were ignored', () => {
  const root = makeFixture('pnpm-monorepo');
  const reviewerTpl = '.claude/kit-templates/agents/reviewer.agent.md.template';
  try {
    expect(runCli(['init', '--yes', root]).status).toBe(0);

    // Simulate a pre-gitignore install: force the templates into the index.
    sh(root, 'git', ['add', '-f', '.claude/kit-templates']);
    sh(root, 'git', ['commit', '-qm', 'committed templates']);
    expect(
      sh(root, 'git', ['ls-files', reviewerTpl]).trim(),
      'precondition: template is tracked',
    ).toBeTruthy();

    // Dry-run reconciles nothing.
    let r = runCli(['update', '--dry-run', root]);
    expect(r.status, r.stderr).toBe(0);
    expect(
      sh(root, 'git', ['ls-files', reviewerTpl]).trim(),
      'dry-run must not untrack',
    ).toBeTruthy();

    // Real update drops templates from the index, keeps the working-tree file
    // and the tracked .gitignore.
    r = runCli(['update', root]);
    expect(r.status, r.stderr).toBe(0);
    expect(
      sh(root, 'git', ['ls-files', reviewerTpl]).trim(),
      'template still tracked after update',
    ).toBe('');
    expect(
      existsSync(join(root, reviewerTpl)),
      'working-tree template must remain on disk',
    ).toBeTruthy();
    expect(
      sh(root, 'git', ['ls-files', '.claude/kit-templates/.gitignore']).trim(),
      '.gitignore must stay tracked',
    ).toBeTruthy();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('U4: fresh init self-gitignores .claude/scripts', () => {
  const root = makeFixture('pnpm-monorepo');
  try {
    expect(runCli(['init', '--yes', root]).status).toBe(0);
    expect(existsSync(join(root, '.claude/scripts/.gitignore'))).toBe(true);
    expect(
      sh(root, 'git', ['ls-files', '.claude/scripts/guard-bash.mjs']).trim(),
      'a fresh install must not commit compiled scripts',
    ).toBe('');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('U5: update untracks .claude/scripts committed before they were ignored', () => {
  const root = makeFixture('pnpm-monorepo');
  const guardScript = '.claude/scripts/guard-bash.mjs';
  try {
    expect(runCli(['init', '--yes', root]).status).toBe(0);

    // Simulate a pre-gitignore install: force scripts into the index.
    sh(root, 'git', ['add', '-f', '.claude/scripts']);
    sh(root, 'git', ['commit', '-qm', 'committed scripts']);
    expect(
      sh(root, 'git', ['ls-files', guardScript]).trim(),
      'precondition: script is tracked',
    ).toBeTruthy();

    const r = runCli(['update', root]);
    expect(r.status, r.stderr).toBe(0);
    expect(
      sh(root, 'git', ['ls-files', guardScript]).trim(),
      'script still tracked after update',
    ).toBe('');
    expect(
      existsSync(join(root, guardScript)),
      'working-tree script must remain on disk',
    ).toBeTruthy();
    expect(
      sh(root, 'git', ['ls-files', '.claude/scripts/.gitignore']).trim(),
      '.gitignore must stay tracked',
    ).toBeTruthy();
    // Nothing committed by update — the staged removal is still pending.
    expect(sh(root, 'git', ['status', '--porcelain']).trim()).not.toBe('');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('U6: scripts.commit: true opts out of the gitignore and migration', () => {
  const root = makeFixture('pnpm-monorepo');
  const guardScript = '.claude/scripts/guard-bash.mjs';
  try {
    expect(runCli(['init', '--yes', root]).status).toBe(0);
    const configPath = join(root, '.claude/kit.config.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    config.scripts = { commit: true };
    writeFileSync(configPath, JSON.stringify(config, null, 2));
    rmSync(join(root, '.claude/scripts/.gitignore'), { force: true });

    // Force-commit scripts (as a repo that opted in to committing them would have).
    sh(root, 'git', ['add', '-A']);
    sh(root, 'git', ['commit', '-qm', 'opt-in commit + config change']);
    expect(
      sh(root, 'git', ['ls-files', guardScript]).trim(),
      'precondition: script is tracked',
    ).toBeTruthy();

    const r = runCli(['update', root]);
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(join(root, '.claude/scripts/.gitignore'))).toBe(false);
    expect(
      sh(root, 'git', ['ls-files', guardScript]).trim(),
      'opted-in repo must keep scripts tracked; update must not untrack them',
    ).toBeTruthy();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('U2: update without an install refuses', () => {
  const root = makeFixture('non-js');
  try {
    const r = runCli(['update', root]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/kit-manifest\.json/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
