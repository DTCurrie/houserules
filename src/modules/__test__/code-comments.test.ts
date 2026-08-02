import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { useInstalledRepo } from '#test/repo';
import { manifestOf, settingsOf } from '#test/installed-tree';

describe('code-comments', () => {
  it('installs a path-scoped rule that stays out of the always-loaded surface', () => {
    const root = useInstalledRepo('pnpm-monorepo', {
      modules: 'code-comments',
    });

    const ruleText = readFileSync(
      join(root, '.claude/rules/code-comments.md'),
      'utf8',
    );
    expect(
      ruleText,
      'without paths: frontmatter this rule loads on every turn',
    ).toMatch(/^---\n(?:.*\n)*?paths:\n/);
    expect(ruleText).toMatch(/^ {2}- ['"]\*\*\/\*\.ts['"]$/m);
    expect(ruleText).toMatch(/Hard cap: 200 characters/);

    const manifest = manifestOf(root);
    expect(manifest.modules.includes('code-comments')).toBeTruthy();
    expect(
      manifest.files['.claude/rules/code-comments.md'],
      'the rule is kit-owned (update-refreshable)',
    ).toBeTruthy();

    const settings = settingsOf(root);
    const cmds = Object.values(settings.hooks ?? {}).flatMap((groups: any) =>
      groups.flatMap((g: any) => g.hooks.map((h: any) => h.command)),
    );
    expect(cmds.some((c: string) => c.includes('code-comments'))).toBe(false);
    expect(
      readFileSync(join(root, 'CLAUDE.md'), 'utf8').includes('code-comments'),
    ).toBe(false);
  });

  it('is not installed by default', () => {
    const root = useInstalledRepo('pnpm-monorepo');
    const manifest = manifestOf(root);
    expect(manifest.modules.includes('code-comments')).toBe(false);
    expect(
      existsSync(join(root, '.claude/rules/code-comments.md')),
      '.claude/rules/code-comments.md absent',
    ).toBe(false);
  });
});
