import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

import { detect, detectFixCommands, suggestPrefix } from '../cli/detect.mjs';
import { renderKitConfig } from '../cli/render.mjs';
import { parsePnpmWorkspaceGlobs } from '../payload/scripts/lib/workspaces.mjs';
import { makeFixture } from './fixtures.mjs';

test('D1/D2/D3: pnpm monorepo detection (schoolyard shape)', () => {
  const root = makeFixture('pnpm-monorepo');
  try {
    const ctx = detect(root);
    assert.equal(ctx.packageManager.name, 'pnpm');
    assert.equal(ctx.packageManager.version, '11.5.0');
    assert.equal(ctx.packageManager.source, 'packageManager');

    // Empty workspace dirs (packages/, toolkits/) must not produce phantom packages.
    assert.deepEqual(ctx.packages.map((p) => p.name).sort(), [
      '@fix/cityville',
      '@fix/studio',
    ]);

    const studio = ctx.targets.find((t) => t.packageName === '@fix/studio');
    assert.equal(studio.pathPrefix, 'apps/studio/');
    assert.equal(studio.sourcePath, 'apps/studio/src');
    assert.equal(studio.prefix, 'STUDIO');
    // Unified `fix` script wins over lint:fix+format:fix (they'd run prettier twice).
    assert.deepEqual(studio.fixCommands, ['fix']);

    assert.equal(ctx.typescript, true);
    assert.equal(ctx.isMonorepo, true);
    assert.equal(ctx.pnpmCatalogModeStrict, true);

    assert.equal(ctx.changesets.configExists, true);
    assert.equal(ctx.changesets.pendingCount, 2); // README.md excluded
    assert.equal(ctx.changesets.devDep, false);
    assert.equal(ctx.changesets.invocation, 'root-script');
    assert.equal(ctx.changesets.rootScript, 'change');
    assert.equal(ctx.changesets.baseBranch, 'main');

    assert.equal(ctx.claude.settingsLocalExists, true);
    assert.equal(ctx.claude.settingsExists, false);
    assert.equal(ctx.claude.claudeMdExists, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('D4: npm single-package detection', () => {
  const root = makeFixture('npm-single');
  try {
    const ctx = detect(root);
    assert.equal(ctx.packageManager.name, 'npm');
    assert.equal(ctx.isMonorepo, false);
    assert.equal(ctx.targets.length, 1);
    const [t] = ctx.targets;
    assert.equal(t.pathPrefix, '');
    assert.equal(t.sourcePath, 'src');
    assert.deepEqual(t.fixCommands, ['lint:fix']);
    assert.equal(ctx.typescript, false);
    assert.equal(ctx.changesets.configExists, false);
    assert.equal(ctx.changesets.invocation, 'absent');
    assert.equal(ctx.claude.claudeMdExists, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('D6: single-package pnpm — filterFlag "" and a write-`format` fixer (CLAUDEKIT-4e98d7)', () => {
  const root = makeFixture('pnpm-single');
  try {
    const ctx = detect(root);
    assert.equal(ctx.packageManager.name, 'pnpm');
    assert.equal(ctx.isMonorepo, false);
    assert.equal(ctx.targets.length, 1);
    // No format:fix, but `format` is `prettier --write` → a real writer, so it's paired.
    assert.deepEqual(ctx.targets[0].fixCommands, ['lint:fix', 'format']);

    // The generated config must NOT emit `--filter` for a single-package repo, or the
    // fix hook would run `pnpm --filter <pkg> lint:fix` and fail (no workspace).
    const config = JSON.parse(
      renderKitConfig(ctx, { moduleIds: ['lint-fix'], targets: ctx.targets }),
    );
    assert.equal(config.fix.runner, 'pnpm');
    assert.equal(config.fix.filterFlag, '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('D5: non-js repo detection does not crash', () => {
  const root = makeFixture('non-js');
  try {
    const ctx = detect(root);
    assert.equal(ctx.packageManager, null);
    assert.deepEqual(ctx.targets, []);
    assert.equal(ctx.changesets.invocation, 'absent');
    assert.equal(ctx.git.isRepo, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('fix-command priority and prefix suggestions', () => {
  assert.deepEqual(
    detectFixCommands({ fix: 'x', 'lint:fix': 'y', 'format:fix': 'z' }),
    ['fix'],
  );
  assert.deepEqual(detectFixCommands({ 'lint:fix': 'y', 'format:fix': 'z' }), [
    'lint:fix',
    'format:fix',
  ]);
  assert.deepEqual(detectFixCommands({ 'format:fix': 'z', format: 'check' }), [
    'format:fix',
  ]);
  assert.equal(detectFixCommands({ format: 'prettier --check .' }), null); // format may be a CHECK
  // A write-`format` (prettier --write) is a valid fixer; pair it with lint:fix, or
  // take it alone. A checker `format` is still ignored (above).
  assert.deepEqual(
    detectFixCommands({
      'lint:fix': 'eslint . --fix',
      format: 'prettier --write .',
    }),
    ['lint:fix', 'format'],
  );
  assert.deepEqual(detectFixCommands({ format: 'prettier --write .' }), [
    'format',
  ]);
  assert.equal(suggestPrefix('@schoolyard/cityville'), 'CITYVILLE');
  assert.equal(suggestPrefix('single-app'), 'SINGLEAPP');
});

test('pnpm-workspace.yaml parse ignores catalog blocks', () => {
  const globs = parsePnpmWorkspaceGlobs(
    [
      'packages:',
      "  - 'packages/*'",
      '  - apps/*',
      '',
      'catalogMode: strict',
      'catalog:',
      "  - 'not-a-glob'",
      '',
    ].join('\n'),
  );
  assert.deepEqual(globs, ['packages/*', 'apps/*']);
});
