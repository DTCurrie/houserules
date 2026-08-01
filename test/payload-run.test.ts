// The payload scripts, executed the way a user's machine executes them: bare node,
// no node_modules anywhere up the tree, a hook payload on stdin.
//
// This is the test that makes the .mts → .mjs compilation trustworthy. Type-checking
// proves the source is consistent; only running the EMITTED file proves the compiler
// did not inject a helper, drop a shebang, or emit syntax the runtime rejects. And
// running it from a directory with no dependencies is the only way to prove the
// zero-runtime-dependency promise for real rather than by inspecting imports.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';

const SCRIPTS = fileURLToPath(
  new URL('../payload-dist/scripts', import.meta.url),
);

/** A directory with no package.json and no node_modules above it inside tmp. */
let bare: string;
beforeAll(() => {
  bare = mkdtempSync(join(tmpdir(), 'kit-bare-'));
});
afterAll(() => {
  rmSync(bare, { recursive: true, force: true });
});

function runHook(script: string, input = '{}') {
  return spawnSync(process.execPath, [join(SCRIPTS, script)], {
    cwd: bare,
    input,
    encoding: 'utf8',
    // Strip NODE_PATH: vitest points it at pnpm's virtual store, which would let a
    // script resolve a package a real user's repo would not have.
    env: (() => {
      const env = { ...process.env };
      delete env.NODE_PATH;
      return env;
    })(),
  });
}

/** Hooks: invoked on every tool call, so a crash is never acceptable. */
const HOOKS = [
  'guard-bash.mjs',
  'guard-read.mjs',
  'session-context.mjs',
  'statusline.mjs',
  'backlog-inject.mjs',
  'debug-session-check.mjs',
  'changeset-check.mjs',
  'lint-format-fix.mjs',
  'regen-on-edit.mjs',
];

test('PR1: every emitted script keeps its shebang and is plain ESM', () => {
  const files = readdirSync(SCRIPTS).filter((f) => f.endsWith('.mjs'));
  expect(files.length).toBeGreaterThan(0);
  for (const file of files) {
    const source = readFileSync(join(SCRIPTS, file), 'utf8');
    expect(
      source.startsWith('#!/usr/bin/env node'),
      `${file} lost its shebang`,
    ).toBe(true);
    // tslib/downlevel helpers would mean the emit is not "source minus types".
    expect(source, `${file} pulled in a compiler helper`).not.toMatch(
      /__awaiter|__generator|tslib|__importDefault/,
    );
  }
});

test.each(HOOKS)(
  'PR2: %s survives an empty payload on bare node without crashing',
  (script) => {
    const r = runHook(script);
    expect(
      r.stderr,
      `${script} must not throw — hooks run on every tool call`,
    ).not.toMatch(/Cannot find (module|package)|SyntaxError|ReferenceError/);
    expect(r.status, `${script} exited ${r.status}: ${r.stderr}`).toBe(0);
  },
);

test.each(HOOKS)('PR3: %s survives a malformed payload too', (script) => {
  const r = runHook(script, 'not json at all');
  expect(r.stderr).not.toMatch(
    /Cannot find (module|package)|SyntaxError: Unexpected|ReferenceError/,
  );
  expect(r.status, `${script} exited ${r.status}: ${r.stderr}`).toBe(0);
});

test('PR4: a CLI-style script fails with a legible message, not a stack trace', () => {
  // Run outside a git work tree, so this exercises the earliest failure path there
  // is. It must still be a sentence a human can act on — a module-resolution error
  // or a raw stack here would mean the compiled output is broken, which is the only
  // thing this phase could plausibly have broken.
  const r = spawnSync(
    process.execPath,
    [join(SCRIPTS, 'changeset-write.mjs')],
    {
      cwd: bare,
      encoding: 'utf8',
    },
  );
  expect(r.status, 'a CLI script may exit loudly, unlike a hook').not.toBe(0);
  expect(r.stderr).toMatch(/Not inside a git work tree|Usage:/);
  expect(r.stderr).not.toMatch(
    /Cannot find (module|package)|ReferenceError|SyntaxError|at Object\./,
  );
});
