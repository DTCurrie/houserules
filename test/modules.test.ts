import { expect, test } from 'vitest';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { makeFixture, runCli, treeHash } from './fixtures.js';

const readJson = (p: string) => JSON.parse(readFileSync(p, 'utf8'));

test('MOD1: `modules` enables an off-by-default module post-init, idempotently', () => {
  const root = makeFixture('pnpm-monorepo');
  try {
    expect(runCli(['init', '--yes', root]).status).toBe(0);
    // terse-style is off by default → not installed yet.
    let manifest = readJson(join(root, '.claude/kit-manifest.json'));
    expect(manifest.modules.includes('terse-style')).toBeFalsy();
    expect(
      existsSync(join(root, '.claude/output-styles/kit-terse.md')),
    ).toBeFalsy();

    const r = runCli(['modules', '--yes', '--modules=terse-style', root]);
    expect(r.status, r.stderr).toBe(0);

    // The module's file lands and the manifest records it.
    expect(
      existsSync(join(root, '.claude/output-styles/kit-terse.md')),
    ).toBeTruthy();
    manifest = readJson(join(root, '.claude/kit-manifest.json'));
    expect(manifest.modules.includes('terse-style')).toBeTruthy();

    // doctor stays green.
    expect(runCli(['doctor', root]).status).toBe(0);

    // Re-running is a true no-op: it's already installed, nothing to add.
    const before = treeHash(root);
    const again = runCli(['modules', '--yes', '--modules=terse-style', root]);
    expect(again.status).toBe(0);
    expect(treeHash(root), 'second run writes nothing').toBe(before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('MOD2: `modules` refuses when the kit is not installed', () => {
  const root = makeFixture('non-js');
  try {
    const r = runCli(['modules', root]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/npx claude-kit init/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('MOD3: `modules --dry-run` previews without writing', () => {
  const root = makeFixture('pnpm-monorepo');
  try {
    expect(runCli(['init', '--yes', root]).status).toBe(0);
    const before = treeHash(root);
    const r = runCli([
      'modules',
      '--yes',
      '--dry-run',
      '--modules=terse-style',
      root,
    ]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/kit-terse\.md/);
    expect(treeHash(root), 'dry run writes nothing').toBe(before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('MOD4: `modules --yes` with no selection just reports status', () => {
  const root = makeFixture('pnpm-monorepo');
  try {
    expect(runCli(['init', '--yes', root]).status).toBe(0);
    const before = treeHash(root);
    const r = runCli(['modules', '--yes', root]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/terse-style/); // listed as available
    expect(treeHash(root), 'listing writes nothing').toBe(before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
