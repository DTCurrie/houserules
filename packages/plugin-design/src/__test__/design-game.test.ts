import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { useInstalledRepo } from '#test/repo';

const PLUGIN_DESIGN = fileURLToPath(new URL('../..', import.meta.url));
const PLUGINS = [{ name: PLUGIN_DESIGN, alias: 'design' }];

function referencePath(root: string, name: string): string {
  return join(root, '.claude/reference', name);
}

function installedWith(guides?: string[]): string {
  return useInstalledRepo('pnpm-monorepo', {
    modules: 'design/design-game',
    plugins: PLUGINS,
    ...(guides ? { moduleOptions: { 'design/design-game': guides } } : {}),
  });
}

describe('design game references', () => {
  it('installs neither game reference when no options were chosen', () => {
    const root = installedWith();

    expect(existsSync(referencePath(root, 'design-game-hud.md'))).toBe(false);
    expect(existsSync(referencePath(root, 'design-game-visual.md'))).toBe(
      false,
    );
  });

  it('installs only the hud reference when hud alone is chosen', () => {
    const root = installedWith(['hud']);

    expect(existsSync(referencePath(root, 'design-game-hud.md'))).toBe(true);
    expect(existsSync(referencePath(root, 'design-game-visual.md'))).toBe(
      false,
    );
  });

  it('installs only the visual reference when visual alone is chosen', () => {
    const root = installedWith(['visual']);

    expect(existsSync(referencePath(root, 'design-game-visual.md'))).toBe(true);
    expect(existsSync(referencePath(root, 'design-game-hud.md'))).toBe(false);
  });

  it('installs both references when both are chosen', () => {
    const root = installedWith(['hud', 'visual']);

    expect(existsSync(referencePath(root, 'design-game-hud.md'))).toBe(true);
    expect(existsSync(referencePath(root, 'design-game-visual.md'))).toBe(true);
  });

  it('installs no advise action and no other file when no option was chosen', () => {
    const root = installedWith();

    expect(existsSync(join(root, '.claude/reference'))).toBe(false);
  });

  it('installs design-game-hud.md with no frontmatter, since it is pull-only', () => {
    const root = installedWith(['hud']);

    expect(
      readFileSync(referencePath(root, 'design-game-hud.md'), 'utf8'),
    ).not.toMatch(/^---/);
  });

  it('installs design-game-visual.md with no frontmatter, since it is pull-only', () => {
    const root = installedWith(['visual']);

    expect(
      readFileSync(referencePath(root, 'design-game-visual.md'), 'utf8'),
    ).not.toMatch(/^---/);
  });

  it('does not link either game reference from the design rule, since they are optional', () => {
    const root = useInstalledRepo('pnpm-monorepo', {
      modules: 'design/design,design/design-game',
      plugins: PLUGINS,
      moduleOptions: { 'design/design-game': ['hud', 'visual'] },
    });

    const ruleText = readFileSync(
      join(root, '.claude/rules/design.md'),
      'utf8',
    );

    expect(ruleText).not.toContain('design-game-hud');
    expect(ruleText).not.toContain('design-game-visual');
  });
});
