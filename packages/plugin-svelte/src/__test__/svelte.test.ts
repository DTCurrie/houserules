import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { useInstalledRepo } from '#test/repo';
import { manifestOf } from '#test/installed-tree';

const PLUGIN_SVELTE = fileURLToPath(new URL('../..', import.meta.url));
const PLUGINS = [{ name: PLUGIN_SVELTE, alias: 'svelte' }];

function pathGlobs(ruleText: string): string[] {
  const body = ruleText.split('---')[1] ?? '';
  return [...body.matchAll(/^ {2}- ['"](.+?)['"]$/gm)].map((m) => m[1]);
}

function installedWith(guides: string[]): string {
  return useInstalledRepo('pnpm-monorepo', {
    modules: 'svelte/svelte',
    plugins: PLUGINS,
    ...(guides.length > 0
      ? { moduleOptions: { 'svelte/svelte': guides } }
      : {}),
  });
}

describe('svelte', () => {
  it('installs the base rule path-scoped and tracks it in the manifest', () => {
    const root = installedWith([]);

    const ruleText = readFileSync(
      join(root, '.claude/rules/svelte.md'),
      'utf8',
    );
    expect(
      ruleText,
      'without paths: frontmatter this rule loads on every turn',
    ).toMatch(/^---\n(?:.*\n)*?paths:\n/);
    expect(pathGlobs(ruleText)).toEqual([
      '**/*.svelte',
      '**/*.svelte.ts',
      '**/*.svelte.js',
    ]);

    const manifest = manifestOf(root);
    expect(manifest.modules.includes('svelte/svelte')).toBeTruthy();
    expect(
      manifest.files['.claude/rules/svelte.md'],
      'the rule BODY is kit-owned (update-refreshable)',
    ).toBeTruthy();
  });

  it('is not installed by default', () => {
    const root = useInstalledRepo('pnpm-monorepo', { plugins: PLUGINS });

    const manifest = manifestOf(root);
    expect(manifest.modules.includes('svelte/svelte')).toBe(false);
    expect(existsSync(join(root, '.claude/rules/svelte.md'))).toBe(false);
  });

  it('installs the SvelteKit guide only when sveltekit was chosen', () => {
    const withGuide = installedWith(['sveltekit']);
    const withoutGuide = installedWith([]);

    expect(existsSync(join(withGuide, '.claude/rules/sveltekit.md'))).toBe(
      true,
    );
    expect(existsSync(join(withoutGuide, '.claude/rules/sveltekit.md'))).toBe(
      false,
    );
  });

  it('is not installed by default for the svelte-mcp module either', () => {
    const root = useInstalledRepo('pnpm-monorepo', { plugins: PLUGINS });

    const manifest = manifestOf(root);
    expect(manifest.modules.includes('svelte/svelte-mcp')).toBe(false);
    expect(existsSync(join(root, '.claude/mcp'))).toBe(false);
  });

  it('installs all three MCP configs under .claude/mcp/ when svelte-mcp is enabled', () => {
    const root = useInstalledRepo('pnpm-monorepo', {
      modules: 'svelte/svelte-mcp',
      plugins: PLUGINS,
    });

    expect(existsSync(join(root, '.claude/mcp/mcp.http.json'))).toBe(true);
    expect(existsSync(join(root, '.claude/mcp/mcp.stdio.json'))).toBe(true);
    expect(existsSync(join(root, '.claude/mcp/vscode.mcp.json'))).toBe(true);

    const manifest = manifestOf(root);
    expect(manifest.modules.includes('svelte/svelte-mcp')).toBeTruthy();
  });

  it('never ships Svelte 4 syntax in an installed rule body', () => {
    const root = useInstalledRepo('pnpm-monorepo', {
      modules: 'svelte/svelte',
      plugins: PLUGINS,
      moduleOptions: { 'svelte/svelte': ['sveltekit'] },
    });
    const rulesDir = join(root, '.claude/rules');
    const codeBlocks = readdirSync(rulesDir)
      .filter((name) => name.endsWith('.md'))
      .flatMap((name) => {
        const body = readFileSync(join(rulesDir, name), 'utf8');
        return [...body.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].map(
          (m) => `${name}: ${m[1]}`,
        );
      });

    const offenders = codeBlocks.flatMap((block) => {
      const violations: string[] = [];
      if (block.includes('export let')) violations.push('export let');
      if (block.includes('on:click')) violations.push('on:click');
      if (/\n\s*\$:/.test(block)) violations.push('$: reactive statement');
      return violations.map((v) => `${block.split(':')[0]}: ${v}`);
    });

    expect(offenders).toEqual([]);
  });
});
