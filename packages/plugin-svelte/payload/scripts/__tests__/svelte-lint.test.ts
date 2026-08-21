import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { useInstalledRepo } from '#test/repo';
import { runScript } from '#test/run';

const SCRIPT = '.claude/scripts/svelte-lint.mjs';
const PLUGIN_DIR = fileURLToPath(new URL('../../..', import.meta.url));

function stage(): string {
  return useInstalledRepo('pnpm-monorepo', {
    modules: 'svelte/svelte',
    plugins: [{ name: PLUGIN_DIR, alias: 'svelte' }],
  });
}

function writeFile(root: string, rel: string, body: string) {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), body);
}

function run(root: string, files: string[]) {
  return runScript(root, SCRIPT, { args: files });
}

describe('svelte-lint.mjs no-slot', () => {
  it('flags a literal <slot> element in markup', () => {
    const root = stage();
    writeFile(root, 'src/Card.svelte', '<div>\n  <slot />\n</div>\n');

    const r = run(root, ['src/Card.svelte']);

    expect(r.status).toBe(1);
    expect(r.stdout).toContain('svelte/no-slot');
    expect(r.stdout).toContain('src/Card.svelte:2');
  });

  it('passes a component using a snippet instead of <slot>', () => {
    const root = stage();
    writeFile(
      root,
      'src/Card.svelte',
      '<div>\n  {@render children?.()}\n</div>\n',
    );

    const r = run(root, ['src/Card.svelte']);

    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain('svelte/no-slot');
  });

  it('ignores <slot> inside an HTML comment', () => {
    const root = stage();
    writeFile(
      root,
      'src/Card.svelte',
      '<!-- old markup used <slot /> here -->\n<div>{@render children?.()}</div>\n',
    );

    const r = run(root, ['src/Card.svelte']);

    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain('svelte/no-slot');
  });
});

describe('svelte-lint.mjs sveltekit/server-export-name', () => {
  it('flags a +server.ts export not in the allowed HTTP-verb set', () => {
    const root = stage();
    writeFile(
      root,
      'src/routes/api/+server.ts',
      "export async function Get() {\n  return new Response('ok');\n}\n",
    );

    const r = run(root, ['src/routes/api/+server.ts']);

    expect(r.status).toBe(1);
    expect(r.stdout).toContain('sveltekit/server-export-name');
    expect(r.stdout).toContain('"Get"');
  });

  it('passes a +server.ts exporting only allowed handler names', () => {
    const root = stage();
    writeFile(
      root,
      'src/routes/api/+server.ts',
      "export async function GET() {\n  return new Response('ok');\n}\n\nexport async function POST() {\n  return new Response('ok');\n}\n",
    );

    const r = run(root, ['src/routes/api/+server.ts']);

    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain('sveltekit/server-export-name');
  });
});

describe('svelte-lint.mjs sveltekit/handle-error-hook', () => {
  it('flags hooks.server.ts with no handleError export', () => {
    const root = stage();
    writeFile(
      root,
      'src/hooks.server.ts',
      'export function handle({ event, resolve }) {\n  return resolve(event);\n}\n',
    );

    const r = run(root, ['src/hooks.server.ts']);

    expect(r.status).toBe(1);
    expect(r.stdout).toContain('sveltekit/handle-error-hook');
  });

  it('passes hooks.client.ts that exports handleError', () => {
    const root = stage();
    writeFile(
      root,
      'src/hooks.client.ts',
      'export function handleError({ error }) {\n  console.error(error);\n}\n',
    );

    const r = run(root, ['src/hooks.client.ts']);

    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain('sveltekit/handle-error-hook');
  });
});

describe('svelte-lint.mjs svelte/eslint-config-missing-rule', () => {
  it('flags an eslint-plugin-svelte import with neither rule enabled', () => {
    const root = stage();
    writeFile(
      root,
      'eslint.config.mjs',
      "import svelte from 'eslint-plugin-svelte';\n\nexport default [\n  ...svelte.configs['flat/base'],\n];\n",
    );

    const r = run(root, ['eslint.config.mjs']);

    expect(r.status).toBe(1);
    expect(r.stdout).toContain('svelte/valid-compile');
    expect(r.stdout).toContain('svelte/no-unused-svelte-ignore');
  });

  it('passes a config that enables both rules explicitly', () => {
    const root = stage();
    writeFile(
      root,
      'eslint.config.mjs',
      "import svelte from 'eslint-plugin-svelte';\n\nexport default [\n  ...svelte.configs['flat/base'],\n  {\n    rules: {\n      'svelte/valid-compile': 'error',\n      'svelte/no-unused-svelte-ignore': 'error',\n    },\n  },\n];\n",
    );

    const r = run(root, ['eslint.config.mjs']);

    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain('svelte/eslint-config-missing-rule');
  });

  it('does not flag a config that never imports eslint-plugin-svelte at all', () => {
    const root = stage();
    writeFile(
      root,
      'eslint.config.mjs',
      "import js from '@eslint/js';\n\nexport default [js.configs.recommended];\n",
    );

    const r = run(root, ['eslint.config.mjs']);

    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain('svelte/eslint-config-missing-rule');
  });
});
