import { describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { useInstalledRepo } from '#test/repo';
import { runScript } from '#test/run';

const PLUGIN_ACCESSIBILITY = fileURLToPath(
  new URL('../../..', import.meta.url),
);
const PLUGINS = [{ name: PLUGIN_ACCESSIBILITY, alias: 'a11y' }];

function installed(): string {
  return useInstalledRepo('pnpm-monorepo', {
    modules: 'a11y/accessibility',
    plugins: PLUGINS,
  });
}

function a11yMarkup(root: string, ...args: string[]) {
  return runScript(root, '.claude/scripts/a11y-markup.mjs', { args });
}

describe('a11y-markup.mjs', () => {
  it('flags a positive tabindex', () => {
    const root = installed();
    writeFileSync(join(root, 'Comp.tsx'), '<div tabindex="3">go</div>');

    const result = a11yMarkup(root, join(root, 'Comp.tsx'));

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('accessibility/no-positive-tabindex');
  });

  it('passes tabindex="0" and tabindex="-1"', () => {
    const root = installed();
    writeFileSync(
      join(root, 'Comp.tsx'),
      '<div tabindex="0">go</div><div tabindex="-1">go</div>',
    );

    const result = a11yMarkup(root, join(root, 'Comp.tsx'));

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('no-positive-tabindex');
  });

  it('flags an iframe with no title', () => {
    const root = installed();
    writeFileSync(join(root, 'Comp.tsx'), '<iframe src="https://a.com" />');

    const result = a11yMarkup(root, join(root, 'Comp.tsx'));

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('accessibility-html/iframe-title');
  });

  it('passes an iframe with a title', () => {
    const root = installed();
    writeFileSync(
      join(root, 'Comp.tsx'),
      '<iframe src="https://a.com" title="widget" />',
    );

    const result = a11yMarkup(root, join(root, 'Comp.tsx'));

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('iframe-title');
  });

  it('flags a Vue attribute bound to the literal false', () => {
    const root = installed();
    writeFileSync(
      join(root, 'Comp.vue'),
      '<template><div :aria-hidden="false"></div></template>',
    );

    const result = a11yMarkup(root, join(root, 'Comp.vue'));

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('accessibility-vue/bound-false-attribute');
  });

  it('passes a Vue attribute bound to a variable', () => {
    const root = installed();
    writeFileSync(
      join(root, 'Comp.vue'),
      '<template><div :aria-hidden="isHidden"></div></template>',
    );

    const result = a11yMarkup(root, join(root, 'Comp.vue'));

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('bound-false-attribute');
  });

  it('flags an unkeyed Svelte each block', () => {
    const root = installed();
    writeFileSync(
      join(root, 'Comp.svelte'),
      '{#each items as item}<li>{item.name}</li>{/each}',
    );

    const result = a11yMarkup(root, join(root, 'Comp.svelte'));

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('accessibility-svelte/each-key');
  });

  it('passes a keyed Svelte each block', () => {
    const root = installed();
    writeFileSync(
      join(root, 'Comp.svelte'),
      '{#each items as item (item.id)}<li>{item.name}</li>{/each}',
    );

    const result = a11yMarkup(root, join(root, 'Comp.svelte'));

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('each-key');
  });

  it('flags react present with no eslint-plugin-jsx-a11y in package.json', () => {
    const root = installed();
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ dependencies: { react: '^18.0.0' } }),
    );

    const result = a11yMarkup(root, join(root, 'package.json'));

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('accessibility-react/install-linter');
  });

  it('passes react present with eslint-plugin-jsx-a11y in package.json', () => {
    const root = installed();
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({
        dependencies: { react: '^18.0.0' },
        devDependencies: { 'eslint-plugin-jsx-a11y': '^6.0.0' },
      }),
    );

    const result = a11yMarkup(root, join(root, 'package.json'));

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('install-linter');
  });

  it('prints what it declines to check', () => {
    const root = installed();
    writeFileSync(join(root, 'Comp.tsx'), '<div>ok</div>');

    const result = a11yMarkup(root, join(root, 'Comp.tsx'));

    expect(result.stdout).toContain('Not checked by this checker');
  });
});
