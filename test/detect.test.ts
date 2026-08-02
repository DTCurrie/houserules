import { expect, test } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import {
  detect,
  detectFixCommands,
  suggestPrefix,
  trackedScriptFiles,
  untrackFromIndex,
} from '../src/detect.js';
import { renderKitConfig } from '../src/render.js';
import { parsePnpmWorkspaceGlobs } from '../payload-dist/scripts/lib/workspaces.mjs';
import { makeFixture } from './fixtures.js';

test('D1/D2/D3: pnpm monorepo detection (schoolyard shape)', () => {
  const root = makeFixture('pnpm-monorepo');
  try {
    const ctx = detect(root);
    expect(ctx.packageManager!.name).toBe('pnpm');
    expect(ctx.packageManager!.version).toBe('11.5.0');
    expect(ctx.packageManager!.source).toBe('packageManager');

    // Empty workspace dirs (packages/, toolkits/) must not produce phantom packages.
    expect(ctx.packages.map((p) => p.name).sort()).toEqual([
      '@fix/cityville',
      '@fix/studio',
    ]);

    const studio = ctx.targets.find((t) => t.packageName === '@fix/studio')!;
    expect(studio.pathPrefix).toBe('apps/studio/');
    expect(studio.sourcePath).toBe('apps/studio/src');
    expect(studio.prefix).toBe('STUDIO');
    // Unified `fix` script wins over lint:fix+format:fix (they'd run prettier twice).
    expect(studio.fixCommands).toEqual(['fix']);

    expect(ctx.typescript).toBe(true);
    expect(ctx.isMonorepo).toBe(true);
    expect(ctx.pnpmCatalogModeStrict).toBe(true);

    expect(ctx.changesets.configExists).toBe(true);
    expect(ctx.changesets.pendingCount).toBe(2); // README.md excluded
    expect(ctx.changesets.devDep).toBe(false);
    expect(ctx.changesets.invocation).toBe('root-script');
    expect(ctx.changesets.rootScript).toBe('change');
    expect(ctx.changesets.baseBranch).toBe('main');

    expect(ctx.claude.settingsLocalExists).toBe(true);
    expect(ctx.claude.settingsExists).toBe(false);
    expect(ctx.claude.claudeMdExists).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('D4: npm single-package detection', () => {
  const root = makeFixture('npm-single');
  try {
    const ctx = detect(root);
    expect(ctx.packageManager!.name).toBe('npm');
    expect(ctx.isMonorepo).toBe(false);
    expect(ctx.targets.length).toBe(1);
    const [t] = ctx.targets;
    expect(t.pathPrefix).toBe('');
    expect(t.sourcePath).toBe('src');
    expect(t.fixCommands).toEqual(['lint:fix']);
    expect(ctx.typescript).toBe(false);
    expect(ctx.changesets.configExists).toBe(false);
    expect(ctx.changesets.invocation).toBe('absent');
    expect(ctx.claude.claudeMdExists).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('D6: single-package pnpm — filterFlag "" and a write-`format` fixer (CLAUDEKIT-4e98d7)', () => {
  const root = makeFixture('pnpm-single');
  try {
    const ctx = detect(root);
    expect(ctx.packageManager!.name).toBe('pnpm');
    expect(ctx.isMonorepo).toBe(false);
    expect(ctx.targets.length).toBe(1);
    // No format:fix, but `format` is `prettier --write` → a real writer, so it's paired.
    expect(ctx.targets[0].fixCommands).toEqual(['lint:fix', 'format']);

    // The generated config must NOT emit `--filter` for a single-package repo, or the
    // fix hook would run `pnpm --filter <pkg> lint:fix` and fail (no workspace).
    const config = JSON.parse(
      renderKitConfig(ctx, {
        moduleIds: ['lint-fix'],
        targets: ctx.targets,
        seedChangesetConfig: false,
      }),
    ) as { fix: { runner: string; filterFlag: string } };
    expect(config.fix.runner).toBe('pnpm');
    expect(config.fix.filterFlag).toBe('');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('D5: non-js repo detection does not crash', () => {
  const root = makeFixture('non-js');
  try {
    const ctx = detect(root);
    expect(ctx.packageManager).toBe(null);
    expect(ctx.targets).toEqual([]);
    expect(ctx.changesets.invocation).toBe('absent');
    expect(ctx.git.isRepo).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('fix-command priority and prefix suggestions', () => {
  expect(
    detectFixCommands({ fix: 'x', 'lint:fix': 'y', 'format:fix': 'z' }),
  ).toEqual(['fix']);
  expect(detectFixCommands({ 'lint:fix': 'y', 'format:fix': 'z' })).toEqual([
    'lint:fix',
    'format:fix',
  ]);
  expect(detectFixCommands({ 'format:fix': 'z', format: 'check' })).toEqual([
    'format:fix',
  ]);
  expect(detectFixCommands({ format: 'prettier --check .' })).toBe(null); // format may be a CHECK
  // A write-`format` (prettier --write) is a valid fixer. Pair it with lint:fix, or
  // take it alone. A checker `format` is still ignored (above).
  expect(
    detectFixCommands({
      'lint:fix': 'eslint . --fix',
      format: 'prettier --write .',
    }),
  ).toEqual(['lint:fix', 'format']);
  expect(detectFixCommands({ format: 'prettier --write .' })).toEqual([
    'format',
  ]);
  expect(suggestPrefix('@schoolyard/cityville')).toBe('CITYVILLE');
  expect(suggestPrefix('single-app')).toBe('SINGLEAPP');
});

// End-to-end counterpart to test/workspaces.test.ts: the flow sequence,
// the `**` glob and the `!negation` all have to survive detect() into targets[].
test('flow sequence + globstar + negation reach targets end to end', () => {
  const root = makeFixture('pnpm-flow-monorepo');
  try {
    const ctx = detect(root);
    expect(ctx.isMonorepo).toBe(true);
    expect(ctx.packages.map((p) => p.name).sort()).toEqual([
      '@flow/nested',
      '@flow/plain',
    ]);

    const nested = ctx.targets.find((t) => t.packageName === '@flow/nested')!;
    expect(nested.pathPrefix).toBe('libs/group/nested/');
    expect(nested.sourcePath).toBe('libs/group/nested/src');
    expect(ctx.targets.some((t) => t.packageName === '@flow/legacy')).toBe(
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('trackedScriptFiles finds a pre-gitignore install, untrackFromIndex stages (not commits) their removal', () => {
  const root = makeFixture('committed-scripts');
  try {
    const tracked = trackedScriptFiles(root).sort();
    expect(tracked).toEqual(
      [
        '.claude/scripts/changeset-check.mjs',
        '.claude/scripts/guard-bash.mjs',
        '.claude/scripts/session-context.mjs',
      ].sort(),
    );

    expect(untrackFromIndex(root, tracked)).toBe(true);
    expect(trackedScriptFiles(root)).toEqual([]);

    // Working-tree files remain on disk, and the removal is only staged.
    for (const rel of tracked)
      expect(existsSync(join(root, rel)), `${rel} must remain on disk`).toBe(
        true,
      );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
  expect(globs).toEqual(['packages/*', 'apps/*']);
});
