import { expect, test } from 'vitest';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { makeFixture, runCli, runScript } from './fixtures.js';

const readJson = (p: string): Record<string, any> =>
  JSON.parse(readFileSync(p, 'utf8'));
const configPath = (root: string): string =>
  join(root, '.claude/kit.config.json');
const editConfig = (
  root: string,
  fn: (c: Record<string, any>) => void,
): void => {
  const c = readJson(configPath(root));
  fn(c);
  writeFileSync(configPath(root), JSON.stringify(c, null, 2));
};
const readInput = (obj: unknown): { input: string } => ({
  input: JSON.stringify(obj),
});

test('GR1: read-guard blocks unbounded reads of generated/oversized files; bounded + normal reads pass', () => {
  const root = makeFixture('pnpm-monorepo');
  const GUARD = '.claude/scripts/guard-read.mjs';
  try {
    expect(runCli(['init', '--yes', '--modules=read-guard', root]).status).toBe(
      0,
    );
    expect(existsSync(join(root, GUARD)), 'guard installed').toBeTruthy();
    // Hook wired at PreToolUse(Read); doctor validates it (exit 0).
    const settings = readJson(join(root, '.claude/settings.json'));
    const cmds = (settings.hooks.PreToolUse ?? []).flatMap((g: any) =>
      g.hooks.map((h: any) => h.command),
    );
    expect(cmds.some((c: string) => c.includes('guard-read.mjs'))).toBeTruthy();
    expect(runCli(['doctor', root]).status).toBe(0);

    // Whole-file read of a denylisted lockfile → blocked (exit 2).
    let r = runScript(
      root,
      GUARD,
      readInput({ tool_input: { file_path: 'pnpm-lock.yaml' } }),
    );
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/read guard/);

    // Same file WITH offset/limit → a targeted read passes (exit 0).
    r = runScript(
      root,
      GUARD,
      readInput({ tool_input: { file_path: 'pnpm-lock.yaml', limit: 40 } }),
    );
    expect(r.status, r.stderr).toBe(0);

    // A normal small source file → passes.
    r = runScript(
      root,
      GUARD,
      readInput({ tool_input: { file_path: 'apps/studio/src/main.ts' } }),
    );
    expect(r.status, r.stderr).toBe(0);

    // Oversized (maxBytes) whole-file read → blocked.
    editConfig(root, (c) => {
      c.readGuard = { maxBytes: 5 };
    });
    r = runScript(
      root,
      GUARD,
      readInput({ tool_input: { file_path: 'apps/studio/src/main.ts' } }),
    );
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/large/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('BI1: backlog-inject injects a referenced entry from the log; unknown/absent ID → nothing', () => {
  const root = makeFixture('pnpm-monorepo');
  const INJECT = '.claude/scripts/backlog-inject.mjs';
  try {
    // backlog is a default module — the injector ships with it.
    expect(runCli(['init', '--yes', root]).status).toBe(0);
    expect(
      existsSync(join(root, INJECT)),
      'injector installed by backlog',
    ).toBeTruthy();
    const settings = readJson(join(root, '.claude/settings.json'));
    const cmds = (settings.hooks.UserPromptSubmit ?? []).flatMap((g: any) =>
      g.hooks.map((h: any) => h.command),
    );
    expect(
      cmds.some((c: string) => c.includes('backlog-inject.mjs')),
      'hook wired',
    ).toBeTruthy();
    expect(runCli(['doctor', root]).status).toBe(0);

    // Log a real entry, capture its ID.
    const add = runScript(root, '.claude/scripts/backlog-log.mjs', {
      args: [
        'add',
        'TEST',
        'BACKLOG.md',
        'Cache the token',
        'body: memoize it',
        '--chat=none',
      ],
    });
    expect(add.status, add.stderr).toBe(0);
    const id = add.stdout.trim().split('\n')[0];
    expect(id).toMatch(/^TEST-[0-9a-f]{6}$/);

    // A prompt referencing the ID → the decoded entry is injected on stdout.
    let r = runScript(root, INJECT, {
      input: JSON.stringify({ prompt: `please pick up ${id} next` }),
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(new RegExp(id));
    expect(r.stdout).toMatch(/Cache the token/);
    expect(r.stdout).toMatch(/memoize it/);

    // An unknown but well-formed ID → inject nothing.
    r = runScript(root, INJECT, {
      input: JSON.stringify({ prompt: 'what about FAKE-abcdef?' }),
    });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('');

    // No ID at all → nothing.
    r = runScript(root, INJECT, {
      input: JSON.stringify({ prompt: 'just a normal prompt' }),
    });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('RG1: regen runs a matching target generator; failure → exit 2; non-match → no-op', () => {
  const root = makeFixture('pnpm-monorepo');
  const REGEN = '.claude/scripts/regen-on-edit.mjs';
  try {
    expect(runCli(['init', '--yes', '--modules=regen', root]).status).toBe(0);
    expect(existsSync(join(root, REGEN)), 'regen installed').toBeTruthy();
    const settings = readJson(join(root, '.claude/settings.json'));
    const cmds = (settings.hooks.PostToolUse ?? []).flatMap((g: any) =>
      g.hooks.map((h: any) => h.command),
    );
    expect(
      cmds.some((c: string) => c.includes('regen-on-edit.mjs')),
    ).toBeTruthy();
    expect(runCli(['doctor', root]).status).toBe(0);

    // A passing generator on the studio target.
    editConfig(root, (c) => {
      const studio = c.targets.find((t: any) => t.name === 'studio');
      studio.regen = {
        sourceGlob: 'apps/studio/**',
        command: 'echo ran > regen-marker.txt',
      };
    });

    // Edit a matching file → generator runs (marker written), exit 0.
    let r = runScript(
      root,
      REGEN,
      readInput({ tool_input: { file_path: 'apps/studio/src/main.ts' } }),
    );
    expect(r.status, r.stderr).toBe(0);
    expect(
      existsSync(join(root, 'regen-marker.txt')),
      'generator ran',
    ).toBeTruthy();

    // Edit a NON-matching file → no run, exit 0.
    rmSync(join(root, 'regen-marker.txt'));
    r = runScript(
      root,
      REGEN,
      readInput({ tool_input: { file_path: 'games/cityville/src/game.ts' } }),
    );
    expect(r.status, r.stderr).toBe(0);
    expect(
      !existsSync(join(root, 'regen-marker.txt')),
      'did not run',
    ).toBeTruthy();

    // A failing generator → exit 2 with a residue tail.
    editConfig(root, (c) => {
      const studio = c.targets.find((t: any) => t.name === 'studio');
      studio.regen = {
        sourceGlob: 'apps/studio/**',
        command: 'echo boom >&2; exit 1',
      };
    });
    r = runScript(
      root,
      REGEN,
      readInput({ tool_input: { file_path: 'apps/studio/src/main.ts' } }),
    );
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/regen/);
    expect(r.stderr).toMatch(/boom/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
