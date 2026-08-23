import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { useInstalledRepo } from '#test/repo';
import { manifestOf, settingsOf, sha256 } from '#test/installed-tree';

const PLUGIN_ACCESSIBILITY = fileURLToPath(new URL('../..', import.meta.url));
const PLUGINS = [{ name: PLUGIN_ACCESSIBILITY, alias: 'a11y' }];

function pathGlobs(ruleText: string): string[] {
  const body = ruleText.split('---')[1] ?? '';
  return [...body.matchAll(/^ {2}- ['"](.+?)['"]$/gm)]
    .map((m) => m[1])
    .filter((path): path is string => path !== undefined);
}

/** Everything after the closing `---`, the part a body-owned rule's manifest hash covers. */
function ruleBody(ruleText: string): string {
  const match = /^---\n[\s\S]*?\n---[ \t]*\n?/.exec(ruleText);
  return match ? ruleText.slice(match[0].length) : ruleText;
}

describe('accessibility', () => {
  it('installs a path-scoped rule scoped to markup extensions', () => {
    const root = useInstalledRepo('pnpm-monorepo', {
      modules: 'a11y/accessibility',
      plugins: PLUGINS,
    });

    const ruleText = readFileSync(
      join(root, '.claude/rules/accessibility.md'),
      'utf8',
    );
    expect(
      ruleText,
      'without paths: frontmatter this rule loads on every turn',
    ).toMatch(/^---\n(?:.*\n)*?paths:\n/);
    expect(pathGlobs(ruleText)).toEqual([
      '**/*.html',
      '**/*.jsx',
      '**/*.tsx',
      '**/*.svelte',
      '**/*.vue',
      '**/*.astro',
    ]);
  });

  it('records the rule body as kit-owned so update refreshes it', () => {
    const root = useInstalledRepo('pnpm-monorepo', {
      modules: 'a11y/accessibility',
      plugins: PLUGINS,
    });

    const ruleText = readFileSync(
      join(root, '.claude/rules/accessibility.md'),
      'utf8',
    );
    const manifest = manifestOf(root);

    expect(manifest.modules.includes('a11y/accessibility')).toBe(true);
    expect(manifest.files['.claude/rules/accessibility.md']).toEqual(
      expect.objectContaining({ body: sha256(ruleBody(ruleText)) }),
    );
  });

  it('installs the markup checker script alongside the wcag router', () => {
    const root = useInstalledRepo('pnpm-monorepo', {
      modules: 'a11y/accessibility',
      plugins: PLUGINS,
    });

    const scriptSource = readFileSync(
      join(root, '.claude/scripts/a11y-markup.mjs'),
      'utf8',
    );
    const manifest = manifestOf(root);
    const settings = settingsOf(root);

    expect(manifest.files['.claude/scripts/a11y-markup.mjs']).toBe(
      sha256(scriptSource),
    );
    expect(settings.permissions?.allow).toContain(
      'Bash(node .claude/scripts/a11y-markup.mjs:*)',
    );
  });

  it('wires no hook and adds nothing to the always-loaded CLAUDE.md', () => {
    const root = useInstalledRepo('pnpm-monorepo', {
      modules: 'a11y/accessibility',
      plugins: PLUGINS,
    });

    const settings = settingsOf(root);
    const commands = Object.values(settings.hooks ?? {}).flatMap(
      (groups: any) =>
        groups.flatMap((group: any) =>
          group.hooks.map((hook: any) => hook.command),
        ),
    );

    expect(commands.some((c: string) => c.includes('accessibility'))).toBe(
      false,
    );
    expect(
      readFileSync(join(root, 'CLAUDE.md'), 'utf8').includes('accessibility'),
    ).toBe(false);
  });

  it('is not installed by default', () => {
    const root = useInstalledRepo('pnpm-monorepo', { plugins: PLUGINS });

    const manifest = manifestOf(root);

    expect(manifest.modules.includes('a11y/accessibility')).toBe(false);
    expect(
      existsSync(join(root, '.claude/rules/accessibility.md')),
      '.claude/rules/accessibility.md absent',
    ).toBe(false);
  });
});
