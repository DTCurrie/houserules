// `claude-kit modules --disable` — the first path that withdraws something.
//
// The risk it carries is asymmetric: adding a module wrongly leaves clutter, but
// removing one wrongly deletes a user's file or unwires a hook they still need. Every
// test here is about the blast radius of the removal, not the removal itself.

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';

import { makeFixture, runCli } from './fixtures.js';

interface Hook {
  command?: string;
}
interface Settings {
  permissions?: { allow?: string[] };
  hooks?: Record<string, { matcher?: string; hooks?: Hook[] }[]>;
  [key: string]: unknown;
}
interface Manifest {
  modules: string[];
  files: Record<string, string>;
}

function settingsOf(root: string): Settings {
  return JSON.parse(
    readFileSync(join(root, '.claude/settings.json'), 'utf8'),
  ) as Settings;
}

function allCommands(root: string): string[] {
  const settings = settingsOf(root);
  return Object.values(settings.hooks ?? {}).flatMap((groups) =>
    groups.flatMap((g) => (g.hooks ?? []).map((h) => h.command ?? '')),
  );
}

function manifestOf(root: string): Manifest {
  return JSON.parse(
    readFileSync(join(root, '.claude/kit-manifest.json'), 'utf8'),
  ) as Manifest;
}

/** Install with read-guard enabled: it ships one script and one hook, nothing else. */
function installWithReadGuard(root: string): void {
  expect(
    runCli(['init', '--yes', root, '--modules', 'read-guard']).status,
  ).toBe(0);
  expect(existsSync(join(root, '.claude/scripts/guard-read.mjs'))).toBe(true);
  expect(allCommands(root).some((c) => c.includes('guard-read.mjs'))).toBe(
    true,
  );
}

test('MD1: disabling a module removes its script and unwires its hook', () => {
  const root = makeFixture('npm-single');
  try {
    installWithReadGuard(root);
    const r = runCli(['modules', root, '--yes', '--disable', 'read-guard']);
    expect(r.status, r.stderr).toBe(0);

    expect(existsSync(join(root, '.claude/scripts/guard-read.mjs'))).toBe(
      false,
    );
    expect(allCommands(root).some((c) => c.includes('guard-read.mjs'))).toBe(
      false,
    );
    expect(manifestOf(root).modules).not.toContain('read-guard');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('MD2: a disable leaves every OTHER kit hook and the user’s own hook intact', () => {
  const root = makeFixture('npm-single');
  try {
    installWithReadGuard(root);

    // A hook the user added themselves, after install.
    const path = join(root, '.claude/settings.json');
    const settings = settingsOf(root);
    settings.hooks ??= {};
    settings.hooks.Stop ??= [];
    settings.hooks.Stop.push({
      hooks: [{ command: 'node ./my-own-stop-hook.js' }],
    });
    settings.permissions ??= {};
    settings.permissions.allow = [
      ...(settings.permissions.allow ?? []),
      'Bash(echo mine)',
    ];
    writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);

    expect(
      runCli(['modules', root, '--yes', '--disable', 'read-guard']).status,
    ).toBe(0);

    const after = allCommands(root);
    expect(after, 'user hook must survive').toContain(
      'node ./my-own-stop-hook.js',
    );
    expect(
      after.some((c) => c.includes('guard-bash.mjs')),
      "core's guard is a different module and must stay wired",
    ).toBe(true);
    expect(settingsOf(root).permissions?.allow).toContain('Bash(echo mine)');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('MD3: enable → disable → enable returns to the enabled state', () => {
  const root = makeFixture('npm-single');
  try {
    installWithReadGuard(root);
    const enabled = readFileSync(join(root, '.claude/settings.json'), 'utf8');

    expect(
      runCli(['modules', root, '--yes', '--disable', 'read-guard']).status,
    ).toBe(0);
    expect(
      runCli(['modules', root, '--yes', '--modules', 'read-guard']).status,
    ).toBe(0);

    expect(existsSync(join(root, '.claude/scripts/guard-read.mjs'))).toBe(true);
    expect(allCommands(root).some((c) => c.includes('guard-read.mjs'))).toBe(
      true,
    );
    expect(
      JSON.parse(readFileSync(join(root, '.claude/settings.json'), 'utf8')),
      'a full cycle must land back on the same settings document',
    ).toEqual(JSON.parse(enabled));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('MD4: core cannot be disabled', () => {
  const root = makeFixture('npm-single');
  try {
    installWithReadGuard(root);
    const r = runCli(['modules', root, '--yes', '--disable', 'core']);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/Cannot disable core/);
    expect(existsSync(join(root, '.claude/scripts/guard-bash.mjs'))).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('MD5: an unknown module id is refused rather than silently ignored', () => {
  const root = makeFixture('npm-single');
  try {
    installWithReadGuard(root);
    const r = runCli(['modules', root, '--yes', '--disable', 'nope']);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/Unknown module/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('MD6: a file you edited is KEPT on disable; `update --force` is the way out', () => {
  const root = makeFixture('npm-single');
  try {
    installWithReadGuard(root);
    const script = join(root, '.claude/scripts/guard-read.mjs');
    writeFileSync(script, `${readFileSync(script, 'utf8')}\n// my edit\n`);

    expect(
      runCli(['modules', root, '--yes', '--disable', 'read-guard']).status,
    ).toBe(0);
    expect(
      existsSync(script),
      'your edits are never deleted without --force',
    ).toBe(true);
    expect(readFileSync(script, 'utf8')).toMatch(/my edit/);

    // The module is no longer installed, so `--disable` has nothing left to act on.
    // The retired-file sweep belongs to `update`, which prunes anything the current
    // plan no longer produces — hash-guarded, so it still needs --force here.
    expect(runCli(['update', root, '--force']).status).toBe(0);
    expect(existsSync(script)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('MD7: --force on the disable itself removes an edited file immediately', () => {
  const root = makeFixture('npm-single');
  try {
    installWithReadGuard(root);
    const script = join(root, '.claude/scripts/guard-read.mjs');
    writeFileSync(script, `${readFileSync(script, 'utf8')}\n// my edit\n`);

    expect(
      runCli(['modules', root, '--yes', '--force', '--disable', 'read-guard'])
        .status,
    ).toBe(0);
    expect(existsSync(script)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('MD8: --dry-run writes nothing', () => {
  const root = makeFixture('npm-single');
  try {
    installWithReadGuard(root);
    const before = readFileSync(join(root, '.claude/settings.json'), 'utf8');
    expect(
      runCli(['modules', root, '--yes', '--dry-run', '--disable', 'read-guard'])
        .status,
    ).toBe(0);
    expect(existsSync(join(root, '.claude/scripts/guard-read.mjs'))).toBe(true);
    expect(readFileSync(join(root, '.claude/settings.json'), 'utf8')).toBe(
      before,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
