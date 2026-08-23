import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const SCRIPTS = fileURLToPath(
  new URL('../../payload-dist/scripts', import.meta.url),
);

let dependencyFreeDir: string;
beforeAll(() => {
  dependencyFreeDir = mkdtempSync(join(tmpdir(), 'plugin-design-bare-'));
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

function runDesignWithNoArguments() {
  return spawnSync(process.execPath, [join(SCRIPTS, 'design.mjs')], {
    cwd: dependencyFreeDir,
    encoding: 'utf8',
    env: envWithoutVitestNodePath(),
  });
}

describe('the emitted payload scripts at the scripts root', () => {
  const files = readdirSync(SCRIPTS).filter((f) => f.endsWith('.mjs'));

  it('has scripts to check', () => {
    expect(files).toHaveLength(2);
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

describe('design.mjs invoked with no arguments in a dependency-free repo', () => {
  it('exits non-zero', () => {
    const r = runDesignWithNoArguments();
    expect(r.status).not.toBe(0);
  });

  it('reports the failure as an actionable usage sentence rather than a raw stack trace', () => {
    const r = runDesignWithNoArguments();
    expect(r.stderr).toMatch(/usage:/i);
    expect(r.stderr).not.toMatch(
      /Cannot find (module|package)|ReferenceError|SyntaxError|at Object\./,
    );
  });

  it('does not fail to find a Tailwind module, since nothing wires those libs into this command path yet', () => {
    const r = runDesignWithNoArguments();
    expect(r.stderr).not.toMatch(
      /Cannot find (module|package)|ERR_MODULE_NOT_FOUND/,
    );
  });
});

describe('every lib module loads on bare node with no Tailwind installed', () => {
  const libDir = join(SCRIPTS, 'lib');
  const libFiles = readdirSync(libDir).filter((f) => f.endsWith('.mjs'));

  function importLibInChildProcess(file: string) {
    const fileUrl = pathToFileURL(join(libDir, file)).href;
    return spawnSync(
      process.execPath,
      ['--input-type=module', '-e', `await import('${fileUrl}')`],
      {
        cwd: dependencyFreeDir,
        encoding: 'utf8',
        env: envWithoutVitestNodePath(),
      },
    );
  }

  it('has lib files to check', () => {
    expect(libFiles).toHaveLength(13);
  });

  it.each(libFiles)('%s imports and exits 0', (file) => {
    const r = importLibInChildProcess(file);
    expect(r.status, `${file} exited ${r.status}: ${r.stderr}`).toBe(0);
  });
});
