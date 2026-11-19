import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { useInstalledRepo } from '#test/repo';

const PLUGIN_DESIGN = fileURLToPath(new URL('../..', import.meta.url));
const PLUGINS = [{ name: PLUGIN_DESIGN, alias: 'design' }];
const RULE_PATH = '.claude/rules/design.md';

function referenceLinksIn(ruleText: string): string[] {
  return [...ruleText.matchAll(/`(\.\.\/reference\/[^`]+\.md)`/g)]
    .map((match) => match[1])
    .filter((link) => link !== undefined);
}

function resolvedLinksIn(root: string): Array<{
  link: string;
  installed: boolean;
}> {
  const rulePath = join(root, RULE_PATH);
  return referenceLinksIn(readFileSync(rulePath, 'utf8')).map((link) => ({
    link,
    installed: existsSync(resolve(dirname(rulePath), link)),
  }));
}

describe('design rule reference links', () => {
  it('resolves every link when only design is installed', () => {
    const root = useInstalledRepo('pnpm-monorepo', {
      modules: 'design/design',
      plugins: PLUGINS,
    });

    expect(resolvedLinksIn(root)).toEqual([
      { link: '../reference/design-visual-principles.md', installed: true },
      { link: '../reference/design-layout.md', installed: true },
      { link: '../reference/design-performance.md', installed: true },
      { link: '../reference/design-interaction.md', installed: true },
    ]);
  });

  it('resolves the tailwind theming link when design-tailwind is also installed', () => {
    const root = useInstalledRepo('pnpm-monorepo', {
      modules: 'design/design,design/design-tailwind',
      plugins: PLUGINS,
    });

    expect(resolvedLinksIn(root)).toEqual([
      { link: '../reference/design-visual-principles.md', installed: true },
      { link: '../reference/design-layout.md', installed: true },
      { link: '../reference/design-performance.md', installed: true },
      { link: '../reference/design-interaction.md', installed: true },
      { link: '../reference/design-tailwind-theming.md', installed: true },
    ]);
  });

  it('resolves one game guide link when design-game installs only that guide', () => {
    const root = useInstalledRepo('pnpm-monorepo', {
      modules: 'design/design,design/design-game',
      plugins: PLUGINS,
      moduleOptions: { 'design/design-game': ['hud'] },
    });

    expect(resolvedLinksIn(root)).toEqual([
      { link: '../reference/design-visual-principles.md', installed: true },
      { link: '../reference/design-layout.md', installed: true },
      { link: '../reference/design-performance.md', installed: true },
      { link: '../reference/design-interaction.md', installed: true },
      { link: '../reference/design-game-hud.md', installed: true },
    ]);
  });

  it('installs the design rule and the theming reference, and the rule links it, when design-tailwind is chosen without design', () => {
    const root = useInstalledRepo('pnpm-monorepo', {
      modules: 'design/design-tailwind',
      plugins: PLUGINS,
    });

    const referencePath = join(
      root,
      '.claude/reference/design-tailwind-theming.md',
    );
    const rulePath = join(root, '.claude/rules/design.md');

    expect(existsSync(referencePath), `${referencePath} exists`).toBe(true);
    expect(existsSync(rulePath), `${rulePath} exists`).toBe(true);
    expect(readFileSync(rulePath, 'utf8')).toContain(
      '../reference/design-tailwind-theming.md',
    );
  });

  it('installs the design rule and the chosen guide, and the rule links it, when design-game is chosen without design', () => {
    const root = useInstalledRepo('pnpm-monorepo', {
      modules: 'design/design-game',
      plugins: PLUGINS,
      moduleOptions: { 'design/design-game': ['hud'] },
    });

    const referencePath = join(root, '.claude/reference/design-game-hud.md');
    const rulePath = join(root, '.claude/rules/design.md');

    expect(existsSync(referencePath), `${referencePath} exists`).toBe(true);
    expect(existsSync(rulePath), `${rulePath} exists`).toBe(true);
    expect(readFileSync(rulePath, 'utf8')).toContain(
      '../reference/design-game-hud.md',
    );
  });
});
