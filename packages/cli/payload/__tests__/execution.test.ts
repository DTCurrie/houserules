import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const SCRIPTS = fileURLToPath(
  new URL('../../payload-dist/scripts', import.meta.url),
);

let dependencyFreeDir: string;
beforeAll(() => {
  dependencyFreeDir = mkdtempSync(join(tmpdir(), 'kit-bare-'));
});
afterAll(() => {
  rmSync(dependencyFreeDir, { recursive: true, force: true });
});

// Strips NODE_PATH, which vitest points at pnpm's virtual store and would let a script
// resolve a package a real user's repo would not have.
function envWithoutVitestNodePath() {
  const env = { ...process.env };
  delete env.NODE_PATH;
  return env;
}

function runHook(script: string, input = '{}') {
  return spawnSync(process.execPath, [join(SCRIPTS, script)], {
    cwd: dependencyFreeDir,
    input,
    encoding: 'utf8',
    env: envWithoutVitestNodePath(),
  });
}

const HOOKS_THAT_MUST_NEVER_CRASH = [
  'guard-bash.mjs',
  'guard-read.mjs',
  'session-context.mjs',
  'statusline.mjs',
  'ledger-inject.mjs',
  'debug-session-check.mjs',
  'lint-format-fix.mjs',
  'regen-on-edit.mjs',
];

describe('the emitted payload scripts', () => {
  const files = readdirSync(SCRIPTS).filter((f) => f.endsWith('.mjs'));

  it('has scripts to check', () => {
    expect(files.length).toBeGreaterThanOrEqual(10);
  });

  it.each(files)('%s keeps its shebang', (file) => {
    const source = readFileSync(join(SCRIPTS, file), 'utf8');
    expect(source.startsWith('#!/usr/bin/env node')).toBe(true);
  });

  it.each(files)(
    '%s emits no tslib or downlevel helper the source minus types would not have',
    (file) => {
      const source = readFileSync(join(SCRIPTS, file), 'utf8');
      expect(source).not.toMatch(/__awaiter|__generator|tslib|__importDefault/);
    },
  );
});

describe('hooks run on bare node', () => {
  it.each(HOOKS_THAT_MUST_NEVER_CRASH)(
    '%s survives an empty payload without crashing',
    (script) => {
      const r = runHook(script);
      expect(
        r.stderr,
        `${script} must not throw — hooks run on every tool call`,
      ).not.toMatch(/Cannot find (module|package)|SyntaxError|ReferenceError/);
      expect(r.status, `${script} exited ${r.status}: ${r.stderr}`).toBe(0);
    },
  );

  it.each(HOOKS_THAT_MUST_NEVER_CRASH)(
    '%s survives a malformed payload without crashing',
    (script) => {
      const r = runHook(script, 'not json at all');
      expect(r.stderr).not.toMatch(
        /Cannot find (module|package)|SyntaxError: Unexpected|ReferenceError/,
      );
      expect(r.status, `${script} exited ${r.status}: ${r.stderr}`).toBe(0);
    },
  );
});

describe('a CLI-style script invoked with no arguments, the earliest failure path there is', () => {
  function runWithoutArguments() {
    return spawnSync(process.execPath, [join(SCRIPTS, 'rename.mjs')], {
      cwd: dependencyFreeDir,
      encoding: 'utf8',
    });
  }

  it('exits non-zero, unlike a hook', () => {
    const r = runWithoutArguments();
    expect(r.status).not.toBe(0);
  });

  it('reports the failure as an actionable sentence rather than a raw stack trace', () => {
    const r = runWithoutArguments();
    expect(r.stderr).toMatch(/not inside a git work tree|usage:/i);
    expect(r.stderr).not.toMatch(
      /Cannot find (module|package)|ReferenceError|SyntaxError|at Object\./,
    );
  });
});
