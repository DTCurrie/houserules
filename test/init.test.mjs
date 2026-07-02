import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { makeFixture, runCli, treeHash } from './fixtures.mjs';

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

test('I1/I4/I5: init --yes on pnpm monorepo — manifest, config, settings, changesets untouched', () => {
  const root = makeFixture('pnpm-monorepo');
  try {
    const changesetHashBefore = treeHash(join(root, '.changeset'));
    const r = runCli(['init', '--yes', root]);
    assert.equal(r.status, 0, r.stderr);

    // Kit-owned files landed.
    for (const rel of [
      '.claude/scripts/guard-bash.mjs',
      '.claude/scripts/lint-format-fix.mjs',
      '.claude/scripts/backlog-log.mjs',
      '.claude/scripts/changeset-write.mjs',
      '.claude/scripts/changeset-check.mjs',
      '.claude/scripts/session-context.mjs',
      '.claude/scripts/rename.mjs',
      '.claude/scripts/lib/workspaces.mjs',
      '.claude/skills/backlog-add/SKILL.md',
      '.claude/skills/changeset/SKILL.md',
      '.claude/agents/backlog-reviewer.md',
      '.claude/agents/changeset-writer.md',
      '.claude/kit-templates/CLAUDE.md.template',
    ]) {
      assert.ok(existsSync(join(root, rel)), `missing ${rel}`);
    }

    // Manifest: right modules, hashed files.
    const manifest = readJson(join(root, '.claude/kit-manifest.json'));
    for (const m of ['core', 'lint-fix', 'backlog', 'changesets', 'session-context', 'rename']) {
      assert.ok(manifest.modules.includes(m), `module ${m}`);
    }
    for (const m of ['reviewers', 'ledger', 'terse-style', 'output-compactor']) {
      assert.ok(!manifest.modules.includes(m), `unexpected module ${m}`);
    }
    assert.match(manifest.files['.claude/scripts/guard-bash.mjs'], /^[0-9a-f]{64}$/);

    // kit.config.json v2 with per-target fixCommands.
    const config = readJson(join(root, '.claude/kit.config.json'));
    assert.equal(config.version, 2);
    assert.equal(config.changesets.enabled, true);
    assert.equal(config.changesets.stopCheck, true);
    assert.equal(config.changesets.baseBranch, 'main');
    const cityville = config.targets.find((t) => t.packageName === '@fix/cityville');
    assert.equal(cityville.prefix, 'CITYVILLE');
    assert.deepEqual(cityville.fixCommands, ['fix']);
    assert.equal(cityville.changelogPath, undefined); // ledger off → no ledger paths

    // settings.json created with the hooks; settings.local.json untouched.
    const settings = readJson(join(root, '.claude/settings.json'));
    const allCommands = Object.values(settings.hooks)
      .flat()
      .flatMap((g) => g.hooks.map((h) => h.command))
      .join('\n');
    for (const s of ['guard-bash', 'lint-format-fix', 'changeset-check', 'session-context']) {
      assert.ok(allCommands.includes(s), `hook ${s} wired`);
    }
    assert.ok(!existsSync(join(root, '.claude/settings.json.bak')), 'no .bak when settings did not pre-exist');
    assert.deepEqual(readJson(join(root, '.claude/settings.local.json')), {
      permissions: { allow: ['WebFetch(domain:example.com)'] },
    });

    // CLAUDE.md seeded with real facts, no raw template placeholders.
    const claudeMd = readFileSync(join(root, 'CLAUDE.md'), 'utf8');
    assert.ok(claudeMd.includes('@fix/studio'));
    assert.ok(claudeMd.includes('changeset'));
    // <ID>-style usage hints in command examples are fine; unfilled template
    // placeholders like <PROJECT_NAME> are not.
    assert.ok(!/<[A-Z][A-Z_]{3,}>/.test(claudeMd), 'no raw placeholders');

    // .changeset/ byte-identical (config respected, pendings untouched).
    assert.equal(treeHash(join(root, '.changeset')), changesetHashBefore);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('I2: init --yes twice is idempotent (zero tree diff)', () => {
  const root = makeFixture('pnpm-monorepo');
  try {
    assert.equal(runCli(['init', '--yes', root]).status, 0);
    const after1 = treeHash(root);
    const r2 = runCli(['init', '--yes', root]);
    assert.equal(r2.status, 0, r2.stderr);
    assert.equal(treeHash(root), after1, 'second init changed the tree');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('I3: init --dry-run writes nothing at all', () => {
  const root = makeFixture('pnpm-monorepo');
  try {
    const before = treeHash(root);
    const r = runCli(['init', '--yes', '--dry-run', root]);
    assert.equal(r.status, 0);
    assert.equal(treeHash(root), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('I6/M3: existing CLAUDE.md and settings.json are respected (npm single)', () => {
  const root = makeFixture('npm-single');
  try {
    const claudeBefore = readFileSync(join(root, 'CLAUDE.md'), 'utf8');
    const settingsBefore = readFileSync(join(root, '.claude/settings.json'), 'utf8');
    const r = runCli(['init', '--yes', root]);
    assert.equal(r.status, 0, r.stderr);

    // CLAUDE.md untouched; additions staged instead.
    assert.equal(readFileSync(join(root, 'CLAUDE.md'), 'utf8'), claudeBefore);
    assert.ok(existsSync(join(root, '.claude/kit-templates/CLAUDE.additions.md')));

    // Settings merged, user entries first and intact; .bak is the pre-merge original.
    const settings = readJson(join(root, '.claude/settings.json'));
    assert.equal(settings.permissions.allow[0], 'Bash(echo hi)');
    assert.equal(settings.hooks.PreToolUse[0].hooks[0].command, 'node   ./my-hook.js   --check');
    assert.ok(settings.hooks.PreToolUse[0].hooks.some((h) => h.command.includes('guard-bash.mjs')));
    assert.equal(readFileSync(join(root, '.claude/settings.json.bak'), 'utf8'), settingsBefore);

    // Single-package target in config.
    const config = readJson(join(root, '.claude/kit.config.json'));
    assert.equal(config.targets.length, 1);
    assert.equal(config.targets[0].pathPrefix, '');
    assert.deepEqual(config.targets[0].fixCommands, ['lint:fix']);

    // Re-run: still idempotent, .bak not regenerated/overwritten.
    const after1 = treeHash(root);
    assert.equal(runCli(['init', '--yes', root]).status, 0);
    assert.equal(treeHash(root), after1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('I7: non-js repo defaults + --modules math', () => {
  const root = makeFixture('non-js');
  try {
    const r = runCli(['init', '--yes', '--modules=-backlog', root]);
    assert.equal(r.status, 0, r.stderr);
    const manifest = readJson(join(root, '.claude/kit-manifest.json'));
    assert.ok(manifest.modules.includes('core'));
    assert.ok(manifest.modules.includes('session-context'));
    assert.ok(!manifest.modules.includes('backlog'), '--modules=-backlog removed it');
    assert.ok(!manifest.modules.includes('changesets'), 'no changesets for non-js');
    assert.ok(!manifest.modules.includes('lint-fix'), 'no fix scripts → off');
    assert.ok(!existsSync(join(root, '.claude/scripts/backlog-log.mjs')));
    assert.ok(!existsSync(join(root, '.claude/scripts/changeset-write.mjs')));

    const bad = runCli(['init', '--yes', '--modules=nonsense', root]);
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /Unknown module/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
