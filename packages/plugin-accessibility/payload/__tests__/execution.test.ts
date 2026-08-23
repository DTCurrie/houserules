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
  const root = mkdtempSync(join(tmpdir(), 'plugin-accessibility-install-'));
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
  dependencyFreeDir = mkdtempSync(join(tmpdir(), 'plugin-accessibility-bare-'));
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
      expect(libFiles.length).toBe(1);
    });

    it.each(libFiles)('%s imports and exits 0', (file) => {
      const r = importLibInChildProcess(file);
      expect(r.status, `${file} exited ${r.status}: ${r.stderr}`).toBe(0);
    });
  });
});

describe('a11y-markup.mjs invoked with no arguments', () => {
  it('exits 0 and reports no findings, since the file list is empty', () => {
    const r = runStaged('a11y-markup.mjs');
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/No findings\./);
  });

  it('does not fail to find a module', () => {
    const r = runStaged('a11y-markup.mjs');
    expect(r.stderr).not.toMatch(
      /Cannot find (module|package)|ReferenceError|SyntaxError|at Object\./,
    );
  });
});

describe('wcag.mjs invoked with no arguments', () => {
  it('exits non-zero and prints usage rather than crashing', () => {
    const r = runStaged('wcag.mjs');
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/Usage:/);
    expect(r.stderr).not.toMatch(
      /Cannot find (module|package)|ReferenceError|SyntaxError|at Object\./,
    );
  });
});
