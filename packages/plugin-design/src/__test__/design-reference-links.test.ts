import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { useInstalledRepo } from '#test/repo';

const PLUGIN_DESIGN = fileURLToPath(new URL('../..', import.meta.url));
const PLUGINS = [{ name: PLUGIN_DESIGN, alias: 'design' }];
const RULE_PATH = '.claude/rules/design.md';

function referenceLinksIn(ruleText: string): string[] {
  return [...ruleText.matchAll(/`(\.\.\/reference\/[^`]+\.md)`/g)].map(
    (match) => match[1],
  );
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
      { link: '../reference/design-game-hud.md', installed: true },
    ]);
  });

  it('installs no design-tailwind-theming reference when design-tailwind is chosen without design', () => {
    const root = useInstalledRepo('pnpm-monorepo', {
      modules: 'design/design-tailwind',
      plugins: PLUGINS,
    });

    expect(
      existsSync(join(root, '.claude/reference/design-tailwind-theming.md')),
    ).toBe(false);
  });

  it('installs no design-game reference when design-game is chosen without design', () => {
    const root = useInstalledRepo('pnpm-monorepo', {
      modules: 'design/design-game',
      plugins: PLUGINS,
      moduleOptions: { 'design/design-game': ['hud'] },
    });

    expect(existsSync(join(root, '.claude/reference/design-game-hud.md'))).toBe(
      false,
    );
  });
});
