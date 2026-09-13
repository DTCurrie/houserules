import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { useInstalledRepo } from '#test/repo';
import { runScript } from '#test/run';

const SCRIPT = '.claude/scripts/test-config.mjs';
const PLUGIN_DIR = fileURLToPath(new URL('../../..', import.meta.url));

function stage(guides?: string[]): string {
  return useInstalledRepo('pnpm-monorepo', {
    modules: 'testing/testing',
    plugins: [{ name: PLUGIN_DIR, alias: 'testing' }],
    ...(guides ? { moduleOptions: { 'testing/testing': guides } } : {}),
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

const TOOLKIT_CONFIG = [
  "import { svelte } from '@sveltejs/vite-plugin-svelte';",
  'expect.requireAssertions();',
  'export default {',
  '  plugins: [svelte()],',
  "  test: { projects: [{ test: { name: 'client' } }] },",
  '};',
  '',
].join('\n');

const TOWER_PUSH_CONFIG = [
  "import { sveltekit } from '@sveltejs/kit/vite';",
  "import { svelteTesting } from '@testing-library/svelte/vite';",
  'expect.requireAssertions();',
  'export default {',
  '  plugins: [sveltekit()],',
  '  test: {',
  '    projects: [',
  "      { test: { name: 'server', environment: 'node' } },",
  '      {',
  '        plugins: [svelteTesting()],',
  "        test: { name: 'client', environment: 'jsdom' },",
  '      },',
  '    ],',
  '  },',
  '};',
  '',
].join('\n');

const LAYOUT_SSR_OFF = 'export const ssr = false;\n';
const LAYOUT_SSR_ON = 'export const ssr = true;\n';

describe('test-config.mjs vitest-project-structure', () => {
  it('does not check Svelte project structure when the Svelte guide is not installed', () => {
    const root = stage(['typescript']);
    writeFile(root, 'vitest.config.ts', TOOLKIT_CONFIG);

    const r = run(root, ['vitest.config.ts']);

    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain('testing-svelte/vitest-project-structure');
    expect(r.stdout).toContain('Svelte vitest project structure');
  });

  it('flags a Svelte vitest config missing client and server when the guide is installed', () => {
    const root = stage(['svelte']);
    writeFile(root, 'vitest.config.ts', TOOLKIT_CONFIG);

    const r = run(root, ['vitest.config.ts']);

    expect(r.status).toBe(1);
    expect(r.stdout).toContain('testing-svelte/vitest-project-structure');
    expect(r.stdout).toContain('ssr, server');
  });

  it('flags a Svelte vitest config missing client and server when --svelte is passed without the guide installed', () => {
    const root = stage(['typescript']);
    writeFile(root, 'vitest.config.ts', TOOLKIT_CONFIG);

    const r = run(root, ['--svelte', 'vitest.config.ts']);

    expect(r.status).toBe(1);
    expect(r.stdout).toContain('testing-svelte/vitest-project-structure');
  });

  it('passes the tower-push server/client split plus a +layout.ts disabling ssr', () => {
    const root = stage(['svelte']);
    writeFile(root, 'vitest.config.ts', TOWER_PUSH_CONFIG);
    writeFile(root, 'src/routes/+layout.ts', LAYOUT_SSR_OFF);

    const r = run(root, ['vitest.config.ts', 'src/routes/+layout.ts']);

    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain('testing-svelte/vitest-project-structure');
  });

  it('flags the tower-push split as missing ssr when no layout disables server rendering', () => {
    const root = stage(['svelte']);
    writeFile(root, 'vitest.config.ts', TOWER_PUSH_CONFIG);
    writeFile(root, 'src/routes/+layout.ts', LAYOUT_SSR_ON);

    const r = run(root, ['vitest.config.ts', 'src/routes/+layout.ts']);

    expect(r.status).toBe(1);
    expect(r.stdout).toContain('testing-svelte/vitest-project-structure');
    expect(r.stdout).toContain('missing the ssr project');
    expect(r.stdout).toContain(
      'ssr is required because no passed file disables server rendering',
    );
  });

  it('ignores a vitest config with no Svelte plugin', () => {
    const root = stage(['svelte']);
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
