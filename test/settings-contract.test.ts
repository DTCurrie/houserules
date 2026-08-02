/**
 * The settings.json safety contract, asserted end-to-end against a real install.
 *
 * `deepMerge` and `deepRemove` are generic document operations. The kit's contract is
 * stricter than they are, and the stricter part is what a port loses first. Every
 * assertion here is a promise the README makes to users:
 *
 * - a user's own hooks and permissions are never removed, rewritten, or reordered
 * - a user's edited variant of a kit hook wins over the kit's stock version
 * - unrelated top-level keys pass through untouched
 * - settings.json is backed up once, before the first kit write
 * - a settings.json the kit cannot parse is never rewritten
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';

import { makeFixture, runCli } from './fixtures.js';

interface Hook {
  type?: string;
  command?: string;
}
interface HookGroup {
  matcher?: string;
  hooks?: Hook[];
}
interface Settings {
  permissions?: { allow?: string[] };
  hooks?: Record<string, HookGroup[]>;
  [key: string]: unknown;
}

function settingsOf(root: string): Settings {
  return JSON.parse(
    readFileSync(join(root, '.claude/settings.json'), 'utf8'),
  ) as Settings;
}

function commandsOf(settings: Settings, event: string): string[] {
  return (settings.hooks?.[event] ?? []).flatMap((g) =>
    (g.hooks ?? []).map((h) => h.command ?? ''),
  );
}

/** A settings.json with a user's own hook, permission, and an unrelated key. */
function seedUserSettings(root: string): void {
  writeFileSync(
    join(root, '.claude/settings.json'),
    `${JSON.stringify(
      {
        permissions: { allow: ['Bash(echo mine)'] },
        hooks: {
          PreToolUse: [
            {
              matcher: 'Bash',
              hooks: [{ type: 'command', command: 'node ./my-own-hook.js' }],
            },
          ],
          Stop: [
            {
              hooks: [{ type: 'command', command: 'node ./my-stop-hook.js' }],
            },
          ],
        },
        someUnrelatedKey: { keepMe: true },
      },
      null,
      2,
    )}\n`,
  );
}

test('SC1: a user hook, permission, and unrelated key all survive install', () => {
  const root = makeFixture('npm-single');
  try {
    seedUserSettings(root);
    expect(runCli(['init', '--yes', root]).status).toBe(0);

    const settings = settingsOf(root);
    expect(commandsOf(settings, 'PreToolUse')).toContain(
      'node ./my-own-hook.js',
    );
    expect(commandsOf(settings, 'Stop')).toContain('node ./my-stop-hook.js');
    expect(settings.permissions?.allow).toContain('Bash(echo mine)');
    expect(settings.someUnrelatedKey).toEqual({ keepMe: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('SC2: the user hook keeps its position — kit entries append, never reorder', () => {
  const root = makeFixture('npm-single');
  try {
    seedUserSettings(root);
    expect(runCli(['init', '--yes', root]).status).toBe(0);

    // The user's PreToolUse(Bash) hook was first before the install. The kit's
    // guard-bash joins the same matcher group and must land AFTER it.
    const group = (settingsOf(root).hooks?.PreToolUse ?? []).find(
      (g) => g.matcher === 'Bash',
    );
    expect(group?.hooks?.[0]?.command).toBe('node ./my-own-hook.js');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('SC3: settings.json is backed up exactly once, before the first kit write', () => {
  const root = makeFixture('npm-single');
  try {
    seedUserSettings(root);
    const original = readFileSync(join(root, '.claude/settings.json'), 'utf8');
    expect(runCli(['init', '--yes', root]).status).toBe(0);

    const backup = join(root, '.claude/settings.json.bak');
    expect(existsSync(backup)).toBe(true);
    expect(
      readFileSync(backup, 'utf8'),
      'the .bak must be the pristine pre-kit file',
    ).toBe(original);

    // A second run must not overwrite the pristine backup with a kit-modified one.
    expect(runCli(['update', root]).status).toBe(0);
    expect(readFileSync(backup, 'utf8')).toBe(original);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('SC4: an unparseable settings.json is refused, never rewritten', () => {
  const root = makeFixture('npm-single');
  try {
    const path = join(root, '.claude/settings.json');
    writeFileSync(path, '{ this is not json\n');
    const before = readFileSync(path, 'utf8');

    const r = runCli(['init', '--yes', root]);
    expect(r.status, 'must refuse rather than clobber').not.toBe(0);
    expect(readFileSync(path, 'utf8')).toBe(before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('SC5: re-running the installer does not duplicate kit hook entries', () => {
  const root = makeFixture('npm-single');
  try {
    seedUserSettings(root);
    expect(runCli(['init', '--yes', root]).status).toBe(0);
    const once = commandsOf(settingsOf(root), 'PreToolUse');
    expect(runCli(['init', '--yes', root]).status).toBe(0);
    const twice = commandsOf(settingsOf(root), 'PreToolUse');
    expect(twice).toEqual(once);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('SC7: an install carrying the OLD unguarded stock command is migrated to the guarded form', () => {
  const root = makeFixture('npm-single');
  try {
    expect(runCli(['init', '--yes', root]).status).toBe(0);

    // Roll a real kit hook back to the historical unguarded stock form, as if this
    // install predates the guard, then re-run update: the kit must recognize its
    // own old stock command and upgrade it in place.
    const path = join(root, '.claude/settings.json');
    const settings = settingsOf(root);
    for (const group of settings.hooks?.PreToolUse ?? []) {
      for (const hook of group.hooks ?? []) {
        if (hook.command?.includes('guard-bash.mjs')) {
          hook.command =
            'node "$CLAUDE_PROJECT_DIR/.claude/scripts/guard-bash.mjs"';
        }
      }
    }
    writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);

    expect(runCli(['update', root]).status).toBe(0);
    const after = commandsOf(settingsOf(root), 'PreToolUse').filter((c) =>
      c.includes('guard-bash.mjs'),
    );
    expect(after, 'exactly one guard-bash entry').toHaveLength(1);
    expect(after[0], 'the entry must now be the guarded form').toMatch(
      /^\[ -f /,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("SC6: a user's edited variant of a kit hook wins over the stock version", () => {
  const root = makeFixture('npm-single');
  try {
    expect(runCli(['init', '--yes', root]).status).toBe(0);

    // Edit the kit's own guard-bash wiring, then re-run: the kit must recognise the
    // script by basename and leave the edited command alone rather than adding a
    // second, stock copy alongside it.
    const path = join(root, '.claude/settings.json');
    const settings = settingsOf(root);
    for (const group of settings.hooks?.PreToolUse ?? []) {
      for (const hook of group.hooks ?? []) {
        if (hook.command?.includes('guard-bash.mjs')) {
          hook.command = `${hook.command} --my-extra-flag`;
        }
      }
    }
    writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);

    expect(runCli(['update', root]).status).toBe(0);
    const after = commandsOf(settingsOf(root), 'PreToolUse').filter((c) =>
      c.includes('guard-bash.mjs'),
    );
    expect(
      after,
      'exactly one guard-bash entry, and it is the edited one',
    ).toHaveLength(1);
    expect(after[0]).toMatch(/--my-extra-flag/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
