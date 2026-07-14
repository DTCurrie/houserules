import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { makeFixture, runCli, treeHash } from './fixtures.mjs';

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

test('MOD1: `modules` enables an off-by-default module post-init, idempotently', () => {
  const root = makeFixture('pnpm-monorepo');
  try {
    assert.equal(runCli(['init', '--yes', root]).status, 0);
    // terse-style is off by default → not installed yet.
    let manifest = readJson(join(root, '.claude/kit-manifest.json'));
    assert.ok(!manifest.modules.includes('terse-style'));
    assert.ok(!existsSync(join(root, '.claude/output-styles/kit-terse.md')));

    const r = runCli(['modules', '--yes', '--modules=terse-style', root]);
    assert.equal(r.status, 0, r.stderr);

    // The module's file lands and the manifest records it.
    assert.ok(existsSync(join(root, '.claude/output-styles/kit-terse.md')));
    manifest = readJson(join(root, '.claude/kit-manifest.json'));
    assert.ok(manifest.modules.includes('terse-style'));

    // doctor stays green.
    assert.equal(runCli(['doctor', root]).status, 0);

    // Re-running is a true no-op: it's already installed, nothing to add.
    const before = treeHash(root);
    const again = runCli(['modules', '--yes', '--modules=terse-style', root]);
    assert.equal(again.status, 0);
    assert.equal(treeHash(root), before, 'second run writes nothing');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('MOD2: `modules` refuses when the kit is not installed', () => {
  const root = makeFixture('non-js');
  try {
    const r = runCli(['modules', root]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /npx claude-kit init/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('MOD3: `modules --dry-run` previews without writing', () => {
  const root = makeFixture('pnpm-monorepo');
  try {
    assert.equal(runCli(['init', '--yes', root]).status, 0);
    const before = treeHash(root);
    const r = runCli([
      'modules',
      '--yes',
      '--dry-run',
      '--modules=terse-style',
      root,
    ]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /kit-terse\.md/);
    assert.equal(treeHash(root), before, 'dry run writes nothing');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('MOD4: `modules --yes` with no selection just reports status', () => {
  const root = makeFixture('pnpm-monorepo');
  try {
    assert.equal(runCli(['init', '--yes', root]).status, 0);
    const before = treeHash(root);
    const r = runCli(['modules', '--yes', root]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /terse-style/); // listed as available
    assert.equal(treeHash(root), before, 'listing writes nothing');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
