import { expect, test } from 'vitest';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { makeFixture, runCli } from './fixtures.js';

const readJson = (p: string): Record<string, any> =>
  JSON.parse(readFileSync(p, 'utf8'));
const sha256 = (s: string): string =>
  createHash('sha256').update(s).digest('hex');

// Plant a retired kit-owned hook script on disk, recorded in the manifest as
// kit-owned, and wired in settings.json alongside a USER hook that must survive.
function plantRetiredHook(
  root: string,
  { modified = false }: { modified?: boolean } = {},
): { retired: string; settingsPath: string; manifestPath: string } {
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
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/below the git root/);
    expect(r.stderr).toMatch(/cd .* npx claude-kit init/);
    expect(
      !existsSync(join(sub, '.claude')),
      'no .claude written in the subdir',
    ).toBeTruthy();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('SIG1: init records the kit settings signature (hooks + permissions) in the manifest', () => {
  const root = makeFixture('pnpm-monorepo');
  try {
    expect(runCli(['init', '--yes', root]).status).toBe(0);
    const manifest = readJson(join(root, '.claude/kit-manifest.json'));
    expect(manifest.settings, 'signature recorded').toBeTruthy();
    expect(
      manifest.settings.hooks.some((h: any) => h.script === 'guard-bash.mjs'),
      'guard-bash hook signed',
    ).toBeTruthy();
    expect(
      manifest.settings.permissions.length > 0,
      'permissions signed',
    ).toBeTruthy();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('PRN1: doctor WARNs a retired wired hook; update prunes the file + unwires it, keeping user hooks', () => {
  const root = makeFixture('pnpm-monorepo');
  try {
    expect(runCli(['init', '--yes', root]).status).toBe(0);
    const { retired, settingsPath, manifestPath } = plantRetiredHook(root);

    // The retired wired hook is visible and the leftover file reads as orphaned. Exit 1,
    // because a wired script no module ships spawns a dead process on every trigger.
    let r = runCli(['doctor', root]);
    expect(r.status, r.stdout).toBe(1);
    expect(r.stdout).toMatch(
      /retired kit hook script compact-tool-output\.mjs.*still wired/,
    );
    expect(r.stdout).toMatch(/compact-tool-output\.mjs: orphaned/);

    // update --dry-run: renders the prune, writes nothing.
    r = runCli(['update', '--dry-run', root]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/compact-tool-output\.mjs/);
    expect(
      existsSync(join(root, retired)),
      'dry-run wrote nothing',
    ).toBeTruthy();

    // update: deletes the file, unwires the kit hook, preserves the user hook.
    r = runCli(['update', root]);
    expect(r.status, r.stderr).toBe(0);
    expect(
      !existsSync(join(root, retired)),
      'retired file deleted',
    ).toBeTruthy();
    const cmds = (readJson(settingsPath).hooks.PostToolUse ?? []).flatMap(
      (g: any) => g.hooks.map((h: any) => h.command),
    );
    expect(
      !cmds.some((c: string) => c.includes('compact-tool-output')),
      'kit hook unwired',
    ).toBeTruthy();
    expect(
      cmds.some((c: string) => c.includes('user-hook.js')),
      'user hook preserved',
    ).toBeTruthy();
    expect(
      !(retired in readJson(manifestPath).files),
      'dropped from manifest',
    ).toBeTruthy();
    // doctor is clean again.
    expect(runCli(['doctor', root]).stdout).not.toMatch(/compact-tool-output/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('PRN2: a retired file with local edits is KEPT; --force removes it', () => {
  const root = makeFixture('pnpm-monorepo');
  try {
    expect(runCli(['init', '--yes', root]).status).toBe(0);
    const { retired } = plantRetiredHook(root, { modified: true });

    // Plain update: hash mismatch → kept, not deleted.
    let r = runCli(['update', root]);
    expect(r.status, r.stderr).toBe(0);
    expect(
      existsSync(join(root, retired)),
      'locally-edited retired file kept',
    ).toBeTruthy();
    expect(r.stdout).toMatch(/locally edited/);

    // --force: removed.
    r = runCli(['update', '--force', root]);
    expect(r.status, r.stderr).toBe(0);
    expect(!existsSync(join(root, retired)), '--force pruned it').toBeTruthy();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('PRN3: doctor WARNs a manifest module this kit no longer defines', () => {
  const root = makeFixture('pnpm-monorepo');
  try {
    expect(runCli(['init', '--yes', root]).status).toBe(0);
    const manifestPath = join(root, '.claude/kit-manifest.json');
    const manifest = readJson(manifestPath);
    manifest.modules = [...manifest.modules, 'ghost-module'];
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    const r = runCli(['doctor', root]);
    expect(r.status, r.stdout).toBe(0);
    expect(r.stdout).toMatch(
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
    expect(runCli(['init', '--yes', '--modules=-backlog', root]).status).toBe(
      0,
    );
    const manifestPath = join(root, '.claude/kit-manifest.json');
    expect(!readJson(manifestPath).modules.includes('backlog')).toBeTruthy();

    const r = runCli(['update', root]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/New default module\(s\) available[\s\S]*backlog/);
    expect(r.stdout).toMatch(/modules --modules=[\w,-]*backlog/);
    // Advisory only: never auto-enabled.
    expect(
      !readJson(manifestPath).modules.includes('backlog'),
      'not auto-enabled',
    ).toBeTruthy();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
