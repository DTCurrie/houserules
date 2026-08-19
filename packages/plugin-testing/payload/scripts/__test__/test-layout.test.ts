import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { useInstalledRepo } from '#test/repo';
import { runScript } from '#test/run';

const SCRIPT = '.claude/scripts/test-layout.mjs';
const PLUGIN_DIR = fileURLToPath(new URL('../../..', import.meta.url));

function stage(): string {
  return useInstalledRepo('pnpm-monorepo', {
    modules: 'testing/testing',
    plugins: [{ name: PLUGIN_DIR, alias: 'testing' }],
  });
}

function run(root: string, args: string[]) {
  return runScript(root, SCRIPT, { args });
}

function writeFile(root: string, rel: string, body: string) {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), body);
}

describe('test-layout.mjs no-e2e-tier', () => {
  it('flags a file matching the .e2e.test tier', () => {
    const root = stage();

    const r = run(root, ['src/foo.e2e.test.ts']);

    expect(r.status).toBe(1);
    expect(r.stdout).toContain('testing/no-e2e-tier');
  });

  it('passes a subject-named test file colocated in __test__', () => {
    const root = stage();

    const r = run(root, ['src/__test__/foo.test.ts']);

    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain('testing/no-e2e-tier');
  });
});

describe('test-layout.mjs test-colocation', () => {
  it('flags a test file that sits beside its subject instead of inside __test__', () => {
    const root = stage();

    const r = run(root, ['src/core/drift.test.ts']);

    expect(r.status).toBe(1);
    expect(r.stdout).toContain('testing/test-colocation');
    expect(r.stdout).toContain('src/core/drift.test.ts');
  });

  it('passes a test file colocated in a __test__ directory', () => {
    const root = stage();

    const r = run(root, ['src/core/__test__/drift.test.ts']);

    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain('testing/test-colocation');
  });

  it('ignores a non-test file, since colocation only governs tests', () => {
    const root = stage();

    const r = run(root, ['src/core/drift.ts']);

    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain('testing/test-colocation');
  });
});

describe('test-layout.mjs test-dir-contents', () => {
  it('flags a fixture file placed inside __test__', () => {
    const root = stage();

    const r = run(root, ['src/core/__test__/fixture.json']);

    expect(r.status).toBe(1);
    expect(r.stdout).toContain('testing/test-dir-contents');
    expect(r.stdout).toContain('src/core/__test__/fixture.json');
  });

  it('passes a test file inside __test__', () => {
    const root = stage();

    const r = run(root, ['src/core/__test__/drift.test.ts']);

    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain('testing/test-dir-contents');
  });

  it('does not flag a snapshot Vitest wrote under __snapshots__', () => {
    const root = stage();

    const r = run(root, ['src/core/__test__/__snapshots__/drift.test.ts.snap']);

    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain('testing/test-dir-contents');
  });
});

describe('test-layout.mjs test-suffix-consistency', () => {
  it('flags a repo that mixes .test. and .spec. suffixes', () => {
    const root = stage();

    const r = run(root, [
      'src/a/__test__/a.test.ts',
      'src/b/__test__/b.spec.ts',
    ]);

    expect(r.status).toBe(1);
    expect(r.stdout).toContain('testing-typescript/test-suffix-consistency');
    expect(r.stdout).toContain('1 .test. file(s), 1 .spec. file(s)');
  });

  it('passes a repo using only .test. suffixes', () => {
    const root = stage();

    const r = run(root, [
      'src/a/__test__/a.test.ts',
      'src/b/__test__/b.test.ts',
    ]);

    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain(
      'testing-typescript/test-suffix-consistency',
    );
  });
});

describe('test-layout.mjs build-output test leakage', () => {
  it('flags a test file that leaked into a built output directory', () => {
    const root = stage();
    writeFile(root, 'dist/core/__test__/drift.test.js', 'export {};\n');
    writeFile(root, 'dist/core/drift.js', 'export {};\n');

    const r = run(root, ['dist']);

    expect(r.status).toBe(1);
    expect(r.stdout).toContain('testing-typescript/build-output-test-leakage');
  });

  it('passes a build output directory with no test files', () => {
    const root = stage();
    writeFile(root, 'dist/core/drift.js', 'export {};\n');

    const r = run(root, ['dist']);

    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain(
      'testing-typescript/build-output-test-leakage',
    );
  });
});

describe('test-layout.mjs given no findings', () => {
  it('prints the declined scope note', () => {
    const root = stage();

    const r = run(root, ['src/core/__test__/drift.test.ts']);

    expect(r.stdout).toContain('Not checked by this checker:');
  });
});
