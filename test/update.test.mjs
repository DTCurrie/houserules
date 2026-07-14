import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  appendFileSync,
  existsSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { makeFixture, runCli, sh } from './fixtures.mjs';

test('U1: update keeps local edits, --force overwrites, stale files refresh', () => {
  const root = makeFixture('pnpm-monorepo');
  try {
    assert.equal(runCli(['init', '--yes', root]).status, 0);

    // Local edit → update must keep it.
    const guardPath = join(root, '.claude/scripts/guard-bash.mjs');
    appendFileSync(guardPath, '// my local tweak\n');
    const edited = readFileSync(guardPath, 'utf8');
    let r = runCli(['update', root]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(
      readFileSync(guardPath, 'utf8'),
      edited,
      'local edit clobbered without --force',
    );

    // --force → kit version restored.
    r = runCli(['update', '--force', root]);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!readFileSync(guardPath, 'utf8').includes('my local tweak'));

    // Stale kit file (manifest hash matches disk, kit has newer content) → refreshed.
    const lintPath = join(root, '.claude/scripts/lint-format-fix.mjs');
    writeFileSync(lintPath, '// OLD KIT VERSION\n');
    const manifestPath = join(root, '.claude/kit-manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.files['.claude/scripts/lint-format-fix.mjs'] = createHash('sha256')
      .update('// OLD KIT VERSION\n')
      .digest('hex');
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    r = runCli(['update', root]);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(
      readFileSync(lintPath, 'utf8').includes('Stop / SubagentStop hook'),
      'stale file not refreshed',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('U3: update untracks reference templates committed before they were ignored', () => {
  const root = makeFixture('pnpm-monorepo');
  const reviewerTpl = '.claude/kit-templates/agents/reviewer.agent.md.template';
  try {
    assert.equal(runCli(['init', '--yes', root]).status, 0);

    // Simulate a pre-gitignore install: force the templates into the index.
    sh(root, 'git', ['add', '-f', '.claude/kit-templates']);
    sh(root, 'git', ['commit', '-qm', 'committed templates']);
    assert.ok(
      sh(root, 'git', ['ls-files', reviewerTpl]).trim(),
      'precondition: template is tracked',
    );

    // Dry-run reconciles nothing.
    let r = runCli(['update', '--dry-run', root]);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(
      sh(root, 'git', ['ls-files', reviewerTpl]).trim(),
      'dry-run must not untrack',
    );

    // Real update drops templates from the index, keeps the working-tree file
    // and the tracked .gitignore.
    r = runCli(['update', root]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(
      sh(root, 'git', ['ls-files', reviewerTpl]).trim(),
      '',
      'template still tracked after update',
    );
    assert.ok(
      existsSync(join(root, reviewerTpl)),
      'working-tree template must remain on disk',
    );
    assert.ok(
      sh(root, 'git', ['ls-files', '.claude/kit-templates/.gitignore']).trim(),
      '.gitignore must stay tracked',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('U2: update without an install refuses', () => {
  const root = makeFixture('non-js');
  try {
    const r = runCli(['update', root]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /kit-manifest\.json/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
