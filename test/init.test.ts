import { expect, test } from 'vitest';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { makeFixture, runCli, treeHash } from './fixtures.js';

const readJson = (p: string) => JSON.parse(readFileSync(p, 'utf8'));

test('I1/I4/I5: init --yes on pnpm monorepo — manifest, config, settings, changesets untouched', () => {
  const root = makeFixture('pnpm-monorepo');
  try {
    const changesetHashBefore = treeHash(join(root, '.changeset'));
    const r = runCli(['init', '--yes', root]);
    expect(r.status, r.stderr).toBe(0);

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
      expect(existsSync(join(root, rel)), `missing ${rel}`).toBeTruthy();
    }
    // Ledger off → its archivist template is not staged.
    expect(
      !existsSync(
        join(root, '.claude/kit-templates/agents/archivist.agent.md.template'),
      ),
      'archivist template must not ship without the ledger module',
    ).toBeTruthy();
    // Templates are reference-only: a self-gitignore keeps them (and the merge
    // helper) uncommitted, while the .gitignore itself stays tracked.
    const templatesIgnore = readFileSync(
      join(root, '.claude/kit-templates/.gitignore'),
      'utf8',
    );
    expect(templatesIgnore).toMatch(/^\*$/m);
    expect(templatesIgnore).toMatch(/^!\.gitignore$/m);

    // Manifest: right modules, hashed files.
    const manifest = readJson(join(root, '.claude/kit-manifest.json'));
    for (const m of [
      'core',
      'lint-fix',
      'backlog',
      'changesets',
      'session-context',
      'rename',
    ]) {
      expect(manifest.modules.includes(m), `module ${m}`).toBeTruthy();
    }
    for (const m of ['reviewers', 'ledger', 'terse-style']) {
      expect(
        !manifest.modules.includes(m),
        `unexpected module ${m}`,
      ).toBeTruthy();
    }
    expect(manifest.files['.claude/scripts/guard-bash.mjs']).toMatch(
      /^[0-9a-f]{64}$/,
    );

    // kit.config.json v2 with per-target fixCommands.
    const config = readJson(join(root, '.claude/kit.config.json'));
    expect(config.version).toBe(2);
    expect(config.changesets.enabled).toBe(true);
    expect(config.changesets.stopCheck).toBe(true);
    expect(config.changesets.baseBranch).toBe('main');
    const cityville = config.targets.find(
      (t: any) => t.packageName === '@fix/cityville',
    );
    expect(cityville.prefix).toBe('CITYVILLE');
    expect(cityville.fixCommands).toEqual(['fix']);
    expect(cityville.changelogPath).toBe(undefined); // ledger off → no ledger paths

    // settings.json created with the hooks; settings.local.json untouched.
    const settings = readJson(join(root, '.claude/settings.json'));
    const allCommands = Object.values(settings.hooks)
      .flat()
      .flatMap((g: any) => g.hooks.map((h: any) => h.command))
      .join('\n');
    for (const s of [
      'guard-bash',
      'lint-format-fix',
      'changeset-check',
      'session-context',
    ]) {
      expect(allCommands.includes(s), `hook ${s} wired`).toBeTruthy();
    }
    expect(
      !existsSync(join(root, '.claude/settings.json.bak')),
      'no .bak when settings did not pre-exist',
    ).toBeTruthy();
    expect(readJson(join(root, '.claude/settings.local.json'))).toEqual({
      permissions: { allow: ['WebFetch(domain:example.com)'] },
    });

    // CLAUDE.md seeded with real facts, no raw template placeholders.
    const claudeMd = readFileSync(join(root, 'CLAUDE.md'), 'utf8');
    expect(claudeMd.includes('@fix/studio')).toBeTruthy();
    expect(claudeMd.includes('changeset')).toBeTruthy();
    // <ID>-style usage hints in command examples are fine; unfilled template
    // placeholders like <PROJECT_NAME> are not.
    expect(
      !/<[A-Z][A-Z_]{3,}>/.test(claudeMd),
      'no raw placeholders',
    ).toBeTruthy();

    // .changeset/ byte-identical (config respected, pendings untouched).
    expect(treeHash(join(root, '.changeset'))).toBe(changesetHashBefore);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('I2: init --yes twice is idempotent (zero tree diff)', () => {
  const root = makeFixture('pnpm-monorepo');
  try {
    expect(runCli(['init', '--yes', root]).status).toBe(0);
    const after1 = treeHash(root);
    const r2 = runCli(['init', '--yes', root]);
    expect(r2.status, r2.stderr).toBe(0);
    expect(treeHash(root), 'second init changed the tree').toBe(after1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('I3: init --dry-run writes nothing at all', () => {
  const root = makeFixture('pnpm-monorepo');
  try {
    const before = treeHash(root);
    const r = runCli(['init', '--yes', '--dry-run', root]);
    expect(r.status).toBe(0);
    expect(treeHash(root)).toBe(before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('I6/M3: existing CLAUDE.md and settings.json are respected (npm single)', () => {
  const root = makeFixture('npm-single');
  try {
    const claudeBefore = readFileSync(join(root, 'CLAUDE.md'), 'utf8');
    const settingsBefore = readFileSync(
      join(root, '.claude/settings.json'),
      'utf8',
    );
    const r = runCli(['init', '--yes', root]);
    expect(r.status, r.stderr).toBe(0);

    // CLAUDE.md gains the kit's managed block, and NOTHING else about the file
    // changes. (Before phase 4 the kit refused to touch it and staged a
    // CLAUDE.additions.md for hand-merging; that flow is retired — the promise is
    // now "only between the markers", which is what this asserts.)
    const claudeAfter = readFileSync(join(root, 'CLAUDE.md'), 'utf8');
    expect(claudeAfter).toContain('<!-- claude-kit:claude-md start -->');
    const withoutBlock = claudeAfter.replace(
      /\n*<!-- claude-kit:claude-md start -->[\s\S]*?<!-- claude-kit:claude-md end -->\n*/,
      '\n\n',
    );
    expect(
      withoutBlock.trim(),
      'every byte outside the markers is the user’s, unchanged',
    ).toBe(claudeBefore.trim());
    expect(
      existsSync(join(root, '.claude/kit-templates/CLAUDE.additions.md')),
      'the hand-merge staging file is retired',
    ).toBe(false);

    // Settings merged, user entries first and intact; .bak is the pre-merge original.
    const settings = readJson(join(root, '.claude/settings.json'));
    expect(settings.permissions.allow[0]).toBe('Bash(echo hi)');
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toBe(
      'node   ./my-hook.js   --check',
    );
    expect(
      settings.hooks.PreToolUse[0].hooks.some((h: any) =>
        h.command.includes('guard-bash.mjs'),
      ),
    ).toBeTruthy();
    expect(readFileSync(join(root, '.claude/settings.json.bak'), 'utf8')).toBe(
      settingsBefore,
    );

    // Single-package target in config.
    const config = readJson(join(root, '.claude/kit.config.json'));
    expect(config.targets.length).toBe(1);
    expect(config.targets[0].pathPrefix).toBe('');
    expect(config.targets[0].fixCommands).toEqual(['lint:fix']);

    // Re-run: still idempotent, .bak not regenerated/overwritten.
    const after1 = treeHash(root);
    expect(runCli(['init', '--yes', root]).status).toBe(0);
    expect(treeHash(root)).toBe(after1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('I7: non-js repo defaults + --modules math', () => {
  const root = makeFixture('non-js');
  try {
    const r = runCli(['init', '--yes', '--modules=-backlog', root]);
    expect(r.status, r.stderr).toBe(0);
    const manifest = readJson(join(root, '.claude/kit-manifest.json'));
    expect(manifest.modules.includes('core')).toBeTruthy();
    expect(manifest.modules.includes('session-context')).toBeTruthy();
    expect(
      !manifest.modules.includes('backlog'),
      '--modules=-backlog removed it',
    ).toBeTruthy();
    expect(
      !manifest.modules.includes('changesets'),
      'no changesets for non-js',
    ).toBeTruthy();
    expect(
      !manifest.modules.includes('lint-fix'),
      'no fix scripts → off',
    ).toBeTruthy();
    expect(
      !existsSync(join(root, '.claude/scripts/backlog-log.mjs')),
    ).toBeTruthy();
    expect(
      !existsSync(join(root, '.claude/scripts/changeset-write.mjs')),
    ).toBeTruthy();

    const bad = runCli(['init', '--yes', '--modules=nonsense', root]);
    expect(bad.status).toBe(1);
    expect(bad.stderr).toMatch(/Unknown module/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
