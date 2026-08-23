import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const SCRIPTS = fileURLToPath(
  new URL('../../payload-dist/scripts', import.meta.url),
);
const SHARED_LIB_DIR = fileURLToPath(
  new URL('../../../payload/payload-dist/scripts/lib', import.meta.url),
);

function envWithoutVitestNodePath() {
  const env = { ...process.env };
  delete env.NODE_PATH;
  return env;
}

function stageInstalledScripts(): string {
  const root = mkdtempSync(join(tmpdir(), 'plugin-changesets-install-'));
  const staged = join(root, 'scripts');
  cpSync(SCRIPTS, staged, { recursive: true });
  const stagedLib = join(staged, 'lib');
  cpSync(SHARED_LIB_DIR, stagedLib, {
    recursive: true,
    filter: (src) => !src.endsWith('.d.mts'),
  });
  return staged;
}

let dependencyFreeDir: string;
let stagedRoot: string;
let stagedScripts: string;

beforeAll(() => {
  dependencyFreeDir = mkdtempSync(join(tmpdir(), 'plugin-changesets-bare-'));
  stagedScripts = stageInstalledScripts();
  stagedRoot = join(stagedScripts, '..');
});

afterAll(() => {
  rmSync(dependencyFreeDir, { recursive: true, force: true });
  rmSync(stagedRoot, { recursive: true, force: true });
});

function runStaged(script: string) {
  return spawnSync(process.execPath, [join(stagedScripts, script)], {
    cwd: dependencyFreeDir,
    encoding: 'utf8',
    env: envWithoutVitestNodePath(),
  });
}

function runHook(script: string, input = '{}') {
  return spawnSync(process.execPath, [join(stagedScripts, script)], {
    cwd: dependencyFreeDir,
    input,
    encoding: 'utf8',
    env: envWithoutVitestNodePath(),
  });
}

describe('every lib module loads on bare node', () => {
  const libDir = join(SCRIPTS, 'lib');
  const hasLibDir = existsSync(libDir);

  const libFiles = hasLibDir
    ? readdirSync(libDir).filter((f) => f.endsWith('.mjs'))
    : [];

  describe.runIf(hasLibDir)('scripts/lib', () => {
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
      expect(libFiles).toHaveLength(0);
    });

    it.each(libFiles)('%s imports and exits 0', (file) => {
      const r = importLibInChildProcess(file);
      expect(r.status, `${file} exited ${r.status}: ${r.stderr}`).toBe(0);
    });
  });
});

const STOP_HOOKS = ['changeset-check.mjs', 'changeset-gate.mjs'];

describe('the Stop hooks, whose own header says every failure path exits 0', () => {
  it.each(STOP_HOOKS)(
    '%s survives an empty payload in a non-git directory, exiting 0',
    (script) => {
      const r = runHook(script);
      expect(
        r.stderr,
        `${script} must not throw — hooks run on every Stop`,
      ).not.toMatch(/Cannot find (module|package)|SyntaxError|ReferenceError/);
      expect(r.status, `${script} exited ${r.status}: ${r.stderr}`).toBe(0);
    },
  );

  it.each(STOP_HOOKS)(
    '%s survives a malformed payload, exiting 0',
    (script) => {
      const r = runHook(script, 'not json at all');
      expect(r.stderr).not.toMatch(
        /Cannot find (module|package)|SyntaxError: Unexpected|ReferenceError/,
      );
      expect(r.status, `${script} exited ${r.status}: ${r.stderr}`).toBe(0);
    },
  );
});

describe('changeset-write.mjs invoked with no arguments in a non-git directory', () => {
  it('exits 1, reporting it needs a git work tree rather than crashing', () => {
    const r = runStaged('changeset-write.mjs');
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/Not inside a git work tree\./);
  });

  it('does not fail to find a module', () => {
    const r = runStaged('changeset-write.mjs');
    expect(r.stderr).not.toMatch(
      /Cannot find (module|package)|ReferenceError|SyntaxError|at Object\./,
    );
  });
});

describe('package-changelog.mjs invoked with no arguments in a non-git directory', () => {
  it('exits 1 from an uncaught git failure, since repoRoot() has no safe fallback outside a work tree', () => {
    const r = runStaged('package-changelog.mjs');
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/Command failed: git rev-parse --show-toplevel/);
  });

  it('does not fail to find a module, so the crash is git, not a broken import', () => {
    const r = runStaged('package-changelog.mjs');
    expect(r.stderr).not.toMatch(/Cannot find (module|package)/);
  });
});
