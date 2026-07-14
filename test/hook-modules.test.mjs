import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { makeFixture, runCli, runScript } from './fixtures.mjs';

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const configPath = (root) => join(root, '.claude/kit.config.json');
const editConfig = (root, fn) => {
  const c = readJson(configPath(root));
  fn(c);
  writeFileSync(configPath(root), JSON.stringify(c, null, 2));
};
const readInput = (obj) => ({ input: JSON.stringify(obj) });

test('GR1: read-guard blocks unbounded reads of generated/oversized files; bounded + normal reads pass', () => {
  const root = makeFixture('pnpm-monorepo');
  const GUARD = '.claude/scripts/guard-read.mjs';
  try {
    assert.equal(
      runCli(['init', '--yes', '--modules=read-guard', root]).status,
      0,
    );
    assert.ok(existsSync(join(root, GUARD)), 'guard installed');
    // Hook wired at PreToolUse(Read); doctor validates it (exit 0).
    const settings = readJson(join(root, '.claude/settings.json'));
    const cmds = (settings.hooks.PreToolUse ?? []).flatMap((g) =>
      g.hooks.map((h) => h.command),
    );
    assert.ok(cmds.some((c) => c.includes('guard-read.mjs')));
    assert.equal(runCli(['doctor', root]).status, 0);

    // Whole-file read of a denylisted lockfile → blocked (exit 2).
    let r = runScript(
      root,
      GUARD,
      readInput({ tool_input: { file_path: 'pnpm-lock.yaml' } }),
    );
    assert.equal(r.status, 2);
    assert.match(r.stderr, /read guard/);

    // Same file WITH offset/limit → a targeted read passes (exit 0).
    r = runScript(
      root,
      GUARD,
      readInput({ tool_input: { file_path: 'pnpm-lock.yaml', limit: 40 } }),
    );
    assert.equal(r.status, 0, r.stderr);

    // A normal small source file → passes.
    r = runScript(
      root,
      GUARD,
      readInput({ tool_input: { file_path: 'apps/studio/src/main.ts' } }),
    );
    assert.equal(r.status, 0, r.stderr);

    // Oversized (maxBytes) whole-file read → blocked.
    editConfig(root, (c) => {
      c.readGuard = { maxBytes: 5 };
    });
    r = runScript(
      root,
      GUARD,
      readInput({ tool_input: { file_path: 'apps/studio/src/main.ts' } }),
    );
    assert.equal(r.status, 2);
    assert.match(r.stderr, /large/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('BI1: backlog-inject injects a referenced entry from the log; unknown/absent ID → nothing', () => {
  const root = makeFixture('pnpm-monorepo');
  const INJECT = '.claude/scripts/backlog-inject.mjs';
  try {
    // backlog is a default module — the injector ships with it.
    assert.equal(runCli(['init', '--yes', root]).status, 0);
    assert.ok(existsSync(join(root, INJECT)), 'injector installed by backlog');
    const settings = readJson(join(root, '.claude/settings.json'));
    const cmds = (settings.hooks.UserPromptSubmit ?? []).flatMap((g) =>
      g.hooks.map((h) => h.command),
    );
    assert.ok(
      cmds.some((c) => c.includes('backlog-inject.mjs')),
      'hook wired',
    );
    assert.equal(runCli(['doctor', root]).status, 0);

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
    assert.equal(add.status, 0, add.stderr);
    const id = add.stdout.trim().split('\n')[0];
    assert.match(id, /^TEST-[0-9a-f]{6}$/);

    // A prompt referencing the ID → the decoded entry is injected on stdout.
    let r = runScript(root, INJECT, {
      input: JSON.stringify({ prompt: `please pick up ${id} next` }),
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, new RegExp(id));
    assert.match(r.stdout, /Cache the token/);
    assert.match(r.stdout, /memoize it/);

    // An unknown but well-formed ID → inject nothing.
    r = runScript(root, INJECT, {
      input: JSON.stringify({ prompt: 'what about FAKE-abcdef?' }),
    });
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '');

    // No ID at all → nothing.
    r = runScript(root, INJECT, {
      input: JSON.stringify({ prompt: 'just a normal prompt' }),
    });
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('RG1: regen runs a matching target generator; failure → exit 2; non-match → no-op', () => {
  const root = makeFixture('pnpm-monorepo');
  const REGEN = '.claude/scripts/regen-on-edit.mjs';
  try {
    assert.equal(runCli(['init', '--yes', '--modules=regen', root]).status, 0);
    assert.ok(existsSync(join(root, REGEN)), 'regen installed');
    const settings = readJson(join(root, '.claude/settings.json'));
    const cmds = (settings.hooks.PostToolUse ?? []).flatMap((g) =>
      g.hooks.map((h) => h.command),
    );
    assert.ok(cmds.some((c) => c.includes('regen-on-edit.mjs')));
    assert.equal(runCli(['doctor', root]).status, 0);

    // A passing generator on the studio target.
    editConfig(root, (c) => {
      const studio = c.targets.find((t) => t.name === 'studio');
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
    assert.equal(r.status, 0, r.stderr);
    assert.ok(existsSync(join(root, 'regen-marker.txt')), 'generator ran');

    // Edit a NON-matching file → no run, exit 0.
    rmSync(join(root, 'regen-marker.txt'));
    r = runScript(
      root,
      REGEN,
      readInput({ tool_input: { file_path: 'games/cityville/src/game.ts' } }),
    );
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!existsSync(join(root, 'regen-marker.txt')), 'did not run');

    // A failing generator → exit 2 with a residue tail.
    editConfig(root, (c) => {
      const studio = c.targets.find((t) => t.name === 'studio');
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
    assert.equal(r.status, 2);
    assert.match(r.stderr, /regen/);
    assert.match(r.stderr, /boom/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
