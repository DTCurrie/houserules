import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { useInstalledRepo } from '#test/repo';

const PLUGIN_ACCESSIBILITY = fileURLToPath(new URL('../..', import.meta.url));
const PLUGINS = [{ name: PLUGIN_ACCESSIBILITY, alias: 'a11y' }];

function pathGlobs(ruleText: string): string[] {
  const body = ruleText.split('---')[1] ?? '';
  return [...body.matchAll(/^ {2}- ['"](.+?)['"]$/gm)].map((m) => m[1]);
}

function installedWith(guides: string[]): string {
  return useInstalledRepo('pnpm-monorepo', {
    modules: 'a11y/accessibility',
    plugins: PLUGINS,
    moduleOptions: { 'a11y/accessibility': guides },
  });
}

function guidePath(root: string, framework: string): string {
  return join(root, `.claude/rules/accessibility-${framework}.md`);
}

describe('accessibility framework guides', () => {
  it('installs only the guides that were chosen', () => {
    const root = installedWith(['react', 'svelte']);

    expect(existsSync(guidePath(root, 'react'))).toBe(true);
    expect(existsSync(guidePath(root, 'svelte'))).toBe(true);
    expect(existsSync(guidePath(root, 'vue'))).toBe(false);
    expect(existsSync(guidePath(root, 'html'))).toBe(false);
  });

  it('always installs the base rule a guide defers to', () => {
    const root = installedWith(['vue']);

    expect(existsSync(join(root, '.claude/rules/accessibility.md'))).toBe(true);
  });

  it.each([
    { framework: 'react', globs: ['**/*.jsx', '**/*.tsx'] },
    { framework: 'svelte', globs: ['**/*.svelte'] },
    { framework: 'vue', globs: ['**/*.vue'] },
    { framework: 'html', globs: ['**/*.html', '**/*.astro'] },
  ])('scopes the $framework guide to $globs', ({ framework, globs }) => {
    const root = installedWith([framework]);

    const guide = readFileSync(guidePath(root, framework), 'utf8');

    expect(pathGlobs(guide)).toEqual(globs);
  });

  it('keeps every guide covered by the base rule it defers to', () => {
    const root = installedWith(['react', 'svelte', 'vue', 'html']);
    const base = pathGlobs(
      readFileSync(join(root, '.claude/rules/accessibility.md'), 'utf8'),
    );

    const uncovered = ['react', 'svelte', 'vue', 'html'].flatMap((framework) =>
      pathGlobs(readFileSync(guidePath(root, framework), 'utf8'))
        .filter((glob) => !base.includes(glob))
        .map((glob) => `${framework}: ${glob}`),
    );

    expect(
      uncovered,
      'a guide loaded on a file where the base rule is absent defers to a rule that is not in context',
    ).toEqual([]);
  });

  it('names the linter that does the mechanical checking it does not', () => {
    const root = installedWith(['react', 'svelte', 'vue']);

    const react = readFileSync(guidePath(root, 'react'), 'utf8');
    const svelte = readFileSync(guidePath(root, 'svelte'), 'utf8');
    const vue = readFileSync(guidePath(root, 'vue'), 'utf8');

    expect(react).toContain('eslint-plugin-jsx-a11y');
    expect(svelte).toContain('svelte-check');
    expect(vue).toContain('eslint-plugin-vuejs-accessibility');
  });

  it('installs the html guide alone when nothing was chosen', () => {
    const root = useInstalledRepo('pnpm-monorepo', {
      modules: 'a11y/accessibility',
      plugins: PLUGINS,
    });

    expect(existsSync(guidePath(root, 'html'))).toBe(true);
    expect(existsSync(guidePath(root, 'react'))).toBe(false);
  });
});
