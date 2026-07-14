import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { makeFixture, runCli } from './fixtures.mjs';

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const sha256 = (s) => createHash('sha256').update(s).digest('hex');

// Plant a retired kit-owned hook script: on disk, recorded in the manifest as
// kit-owned, and wired in settings.json alongside a USER hook that must survive.
function plantRetiredHook(root, { modified = false } = {}) {
  const retired = '.claude/scripts/compact-tool-output.mjs';
  const content = '// retired kit hook\nprocess.exit(0);\n';
  writeFileSync(join(root, retired), content);
  const manifestPath = join(root, '.claude/kit-manifest.json');
  const manifest = readJson(manifestPath);
  // If "modified", record a hash that WON'T match the on-disk file.
  manifest.files[retired] = modified
    ? sha256('something else')
    : sha256(content);
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  const settingsPath = join(root, '.claude/settings.json');
  const settings = readJson(settingsPath);
  settings.hooks.PostToolUse = [
    {
      matcher: 'Bash',
      hooks: [
        {
          type: 'command',
          command:
            'node "$CLAUDE_PROJECT_DIR/.claude/scripts/compact-tool-output.mjs"',
        },
        { type: 'command', command: 'node ./user-hook.js' },
      ],
    },
  ];
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  return { retired, settingsPath, manifestPath };
}

test('PRE1: init below the git toplevel is refused with the cd fix; nothing written', () => {
  const root = makeFixture('pnpm-monorepo');
  try {
    const sub = join(root, 'apps/studio'); // a real subdir of the same git repo
    const r = runCli(['init', '--yes', sub]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /below the git root/);
    assert.match(r.stderr, /cd .* npx claude-kit init/);
    assert.ok(
      !existsSync(join(sub, '.claude')),
      'no .claude written in the subdir',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('SIG1: init records the kit settings signature (hooks + permissions) in the manifest', () => {
  const root = makeFixture('pnpm-monorepo');
  try {
    assert.equal(runCli(['init', '--yes', root]).status, 0);
    const manifest = readJson(join(root, '.claude/kit-manifest.json'));
    assert.ok(manifest.settings, 'signature recorded');
    assert.ok(
      manifest.settings.hooks.some((h) => h.script === 'guard-bash.mjs'),
      'guard-bash hook signed',
    );
    assert.ok(manifest.settings.permissions.length > 0, 'permissions signed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('PRN1: doctor WARNs a retired wired hook; update prunes the file + unwires it, keeping user hooks', () => {
  const root = makeFixture('pnpm-monorepo');
  try {
    assert.equal(runCli(['init', '--yes', root]).status, 0);
    const { retired, settingsPath, manifestPath } = plantRetiredHook(root);

    // doctor: retired wired hook is now visible (exit 0).
    let r = runCli(['doctor', root]);
    assert.equal(r.status, 0, r.stdout);
    assert.match(
      r.stdout,
      /retired kit hook script compact-tool-output\.mjs.*still wired/,
    );

    // update --dry-run: renders the prune, writes nothing.
    r = runCli(['update', '--dry-run', root]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /compact-tool-output\.mjs/);
    assert.ok(existsSync(join(root, retired)), 'dry-run wrote nothing');

    // update: deletes the file, unwires the kit hook, preserves the user hook.
    r = runCli(['update', root]);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!existsSync(join(root, retired)), 'retired file deleted');
    const cmds = (readJson(settingsPath).hooks.PostToolUse ?? []).flatMap((g) =>
      g.hooks.map((h) => h.command),
    );
    assert.ok(
      !cmds.some((c) => c.includes('compact-tool-output')),
      'kit hook unwired',
    );
    assert.ok(
      cmds.some((c) => c.includes('user-hook.js')),
      'user hook preserved',
    );
    assert.ok(
      !(retired in readJson(manifestPath).files),
      'dropped from manifest',
    );
    // doctor is clean again.
    assert.doesNotMatch(runCli(['doctor', root]).stdout, /compact-tool-output/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('PRN2: a retired file with local edits is KEPT; --force removes it', () => {
  const root = makeFixture('pnpm-monorepo');
  try {
    assert.equal(runCli(['init', '--yes', root]).status, 0);
    const { retired } = plantRetiredHook(root, { modified: true });

    // Plain update: hash mismatch → kept, not deleted.
    let r = runCli(['update', root]);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(
      existsSync(join(root, retired)),
      'locally-edited retired file kept',
    );
    assert.match(r.stdout, /locally edited/);

    // --force: removed.
    r = runCli(['update', '--force', root]);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!existsSync(join(root, retired)), '--force pruned it');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('PRN3: doctor WARNs a manifest module this kit no longer defines', () => {
  const root = makeFixture('pnpm-monorepo');
  try {
    assert.equal(runCli(['init', '--yes', root]).status, 0);
    const manifestPath = join(root, '.claude/kit-manifest.json');
    const manifest = readJson(manifestPath);
    manifest.modules = [...manifest.modules, 'ghost-module'];
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    const r = runCli(['doctor', root]);
    assert.equal(r.status, 0, r.stdout);
    assert.match(
      r.stdout,
      /module "ghost-module" which this kit no longer defines/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('ADV1: update advertises a new default module the install lacks — never auto-enables', () => {
  const root = makeFixture('pnpm-monorepo');
  try {
    // Install with backlog (a default) removed, simulating an older install.
    assert.equal(
      runCli(['init', '--yes', '--modules=-backlog', root]).status,
      0,
    );
    const manifestPath = join(root, '.claude/kit-manifest.json');
    assert.ok(!readJson(manifestPath).modules.includes('backlog'));

    const r = runCli(['update', root]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /New default module\(s\) available[\s\S]*backlog/);
    assert.match(r.stdout, /modules --modules=[\w,-]*backlog/);
    // Advisory only — never auto-enabled.
    assert.ok(
      !readJson(manifestPath).modules.includes('backlog'),
      'not auto-enabled',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
