import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { useInstalledRepo } from '#test/repo';
import { runScript } from '#test/run';

const SCRIPT = '.claude/scripts/test-config.mjs';
const PLUGIN_DIR = fileURLToPath(new URL('../../..', import.meta.url));

function stage(): string {
  return useInstalledRepo('pnpm-monorepo', {
    modules: 'testing/testing',
    plugins: [{ name: PLUGIN_DIR, alias: 'testing' }],
  });
}

function writeFile(root: string, rel: string, body: string) {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), body);
}

function run(root: string, files: string[]) {
  return runScript(root, SCRIPT, { args: files });
}

describe('test-config.mjs no-assertion-free-test-config', () => {
  it('flags a vitest config that never calls expect.requireAssertions', () => {
    const root = stage();
    writeFile(
      root,
      'vitest.config.ts',
      'export default { test: { globals: true } };\n',
    );

    const r = run(root, ['vitest.config.ts']);

    expect(r.status).toBe(1);
    expect(r.stdout).toContain('testing/no-assertion-free-test-config');
  });

  it('passes a vitest config that calls expect.requireAssertions', () => {
    const root = stage();
    writeFile(
      root,
      'vitest.config.ts',
      'expect.requireAssertions();\nexport default { test: {} };\n',
    );

    const r = run(root, ['vitest.config.ts']);

    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain('testing/no-assertion-free-test-config');
  });

  it('passes a vitest config using the requireAssertions config option instead of a call', () => {
    const root = stage();
    writeFile(
      root,
      'vitest.config.ts',
      'export default { test: { expect: { requireAssertions: true } } };\n',
    );

    const r = run(root, ['vitest.config.ts']);

    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain('testing/no-assertion-free-test-config');
  });

  it('passes when the call lives in a separate setup file also passed in', () => {
    const root = stage();
    writeFile(root, 'vitest.config.ts', 'export default { test: {} };\n');
    writeFile(root, 'vitest.setup.ts', 'expect.requireAssertions();\n');

    const r = run(root, ['vitest.config.ts', 'vitest.setup.ts']);

    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain('testing/no-assertion-free-test-config');
  });

  it('declines to check when no vitest config was passed at all', () => {
    const root = stage();
    writeFile(root, 'src/foo.ts', 'export const foo = 1;\n');

    const r = run(root, ['src/foo.ts']);

    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain('testing/no-assertion-free-test-config');
  });
});

describe('test-config.mjs typecheck-enabled', () => {
  it('flags a type-test file when no config enables typecheck', () => {
    const root = stage();
    writeFile(
      root,
      'src/__tests__/types.test.ts',
      'expectTypeOf(1).toEqualTypeOf<number>();\n',
    );
    writeFile(root, 'vitest.config.ts', 'export default { test: {} };\n');

    const r = run(root, ['src/__tests__/types.test.ts', 'vitest.config.ts']);

    expect(r.status).toBe(1);
    expect(r.stdout).toContain('testing-typescript/typecheck-enabled');
  });

  it('passes a type-test file when the config enables typecheck', () => {
    const root = stage();
    writeFile(
      root,
      'src/__tests__/types.test.ts',
      'expectTypeOf(1).toEqualTypeOf<number>();\n',
    );
    writeFile(
      root,
      'vitest.config.ts',
      'expect.requireAssertions();\nexport default { test: { typecheck: { enabled: true } } };\n',
    );

    const r = run(root, ['src/__tests__/types.test.ts', 'vitest.config.ts']);

    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain('testing-typescript/typecheck-enabled');
  });

  it('ignores an ordinary test file with no expectTypeOf calls', () => {
    const root = stage();
    writeFile(
      root,
      'src/__tests__/plain.test.ts',
      "it('adds', () => expect(1 + 1).toBe(2));\n",
    );
    writeFile(
      root,
      'vitest.config.ts',
      'expect.requireAssertions();\nexport default { test: {} };\n',
    );

    const r = run(root, ['src/__tests__/plain.test.ts', 'vitest.config.ts']);

    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain('testing-typescript/typecheck-enabled');
  });
});

describe('test-config.mjs vitest-project-structure', () => {
  it('flags a Svelte vitest config missing the ssr and server projects', () => {
    const root = stage();
    writeFile(
      root,
      'vitest.config.ts',
      [
        "import { svelte } from '@sveltejs/vite-plugin-svelte';",
        'export default {',
        '  plugins: [svelte()],',
        "  test: { projects: [{ test: { name: 'client' } }] },",
        '};',
        '',
      ].join('\n'),
    );

    const r = run(root, ['vitest.config.ts']);

    expect(r.status).toBe(1);
    expect(r.stdout).toContain('testing-svelte/vitest-project-structure');
    expect(r.stdout).toContain('ssr, server');
  });

  it('passes a Svelte vitest config naming all three projects', () => {
    const root = stage();
    writeFile(
      root,
      'vitest.config.ts',
      [
        "import { svelte } from '@sveltejs/vite-plugin-svelte';",
        'expect.requireAssertions();',
        'export default {',
        '  plugins: [svelte()],',
        '  test: {',
        '    projects: [',
        "      { test: { name: 'client' } },",
        "      { test: { name: 'ssr' } },",
        "      { test: { name: 'server' } },",
        '    ],',
        '  },',
        '};',
        '',
      ].join('\n'),
    );

    const r = run(root, ['vitest.config.ts']);

    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain('testing-svelte/vitest-project-structure');
  });

  it('ignores a vitest config with no Svelte plugin', () => {
    const root = stage();
    writeFile(
      root,
      'vitest.config.ts',
      'expect.requireAssertions();\nexport default { test: {} };\n',
    );

    const r = run(root, ['vitest.config.ts']);

    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain('testing-svelte/vitest-project-structure');
  });
});

describe('test-config.mjs given no findings', () => {
  it('prints the declined scope note', () => {
    const root = stage();
    writeFile(root, 'vitest.config.ts', 'export default { test: {} };\n');

    const r = run(root, ['vitest.config.ts']);

    expect(r.stdout).toContain('Not checked by this checker:');
  });
});
