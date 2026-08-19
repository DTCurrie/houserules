import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { useInstalledRepo } from '#test/repo';
import { manifestOf, settingsOf } from '#test/installed-tree';

const PLUGIN_DESIGN = fileURLToPath(new URL('../..', import.meta.url));
const PLUGINS = [{ name: PLUGIN_DESIGN, alias: 'design' }];

function installed(): string {
  return useInstalledRepo('pnpm-monorepo', {
    modules: 'design/design',
    plugins: PLUGINS,
  });
}

describe('design', () => {
  it('installs a path-scoped rule with paths: frontmatter', () => {
    const root = installed();

    const ruleText = readFileSync(
      join(root, '.claude/rules/design.md'),
      'utf8',
    );

    expect(
      ruleText,
      'without paths: frontmatter this rule loads on every turn',
    ).toMatch(/^---\n(?:.*\n)*?paths:\n/);
  });

  it('makes no unconditional claim that the design system lives at .claude/design/tokens.json, since a tailwind install has no such file', () => {
    const root = installed();

    const ruleText = readFileSync(
      join(root, '.claude/rules/design.md'),
      'utf8',
    );

    expect(ruleText).not.toMatch(
      /system itself lives at `\.claude\/design\/tokens\.json`/,
    );
  });

  it('installs the reference doc, the script, and the token seed', () => {
    const root = installed();

    expect(
      existsSync(join(root, '.claude/reference/design-visual-principles.md')),
    ).toBe(true);
    expect(existsSync(join(root, '.claude/scripts/design.mjs'))).toBe(true);
    expect(existsSync(join(root, '.claude/design/tokens.json'))).toBe(true);
  });

  it('grants permission to run the script unprompted', () => {
    const root = installed();

    const settings = settingsOf(root);

    expect(settings.permissions?.allow).toContain(
      'Bash(node .claude/scripts/design.mjs:*)',
    );
  });

  it('records the rule, reference, and script as kit-owned but not the token seed', () => {
    const root = installed();

    const manifest = manifestOf(root);

    expect(manifest.modules.includes('design/design')).toBe(true);
    expect(manifest.files['.claude/rules/design.md']).toBeTruthy();
    expect(
      manifest.files['.claude/reference/design-visual-principles.md'],
    ).toBeTruthy();
    expect(manifest.files['.claude/scripts/design.mjs']).toBeTruthy();
    expect(manifest.files['.claude/design/tokens.json']).toBeUndefined();
  });

  it('is not installed by default', () => {
    const root = useInstalledRepo('pnpm-monorepo', { plugins: PLUGINS });

    const manifest = manifestOf(root);

    expect(manifest.modules.includes('design/design')).toBe(false);
    expect(existsSync(join(root, '.claude/rules/design.md'))).toBe(false);
  });
});
