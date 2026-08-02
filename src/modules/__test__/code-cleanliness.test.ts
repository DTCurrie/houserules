import { beforeEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { useInstalledRepo } from '#test/repo';
import { manifestOf, settingsOf } from '#test/installed-tree';

describe('code-cleanliness', () => {
  it('installs a path-scoped rule that stays out of the always-loaded surface', () => {
    const root = useInstalledRepo('pnpm-monorepo', {
      modules: 'code-cleanliness',
    });

    const ruleText = readFileSync(
      join(root, '.claude/rules/code-cleanliness.md'),
      'utf8',
    );
    expect(
      ruleText,
      'without paths: frontmatter this rule loads on every turn',
    ).toMatch(/^---\n(?:.*\n)*?paths:\n/);
    expect(ruleText).toMatch(
      /Prefer intention-revealing names over short ones/,
    );

    const manifest = manifestOf(root);
    expect(manifest.modules.includes('code-cleanliness')).toBeTruthy();
    expect(
      manifest.files['.claude/rules/code-cleanliness.md'],
      'the rule is kit-owned (update-refreshable)',
    ).toBeTruthy();

    const settings = settingsOf(root);
    const cmds = Object.values(settings.hooks ?? {}).flatMap((groups: any) =>
      groups.flatMap((g: any) => g.hooks.map((h: any) => h.command)),
    );
    expect(cmds.some((c: string) => c.includes('code-cleanliness'))).toBe(
      false,
    );
    expect(
      readFileSync(join(root, 'CLAUDE.md'), 'utf8').includes(
        'code-cleanliness',
      ),
    ).toBe(false);
  });

  it('is not installed by default', () => {
    const root = useInstalledRepo('pnpm-monorepo');
    const manifest = manifestOf(root);
    expect(manifest.modules.includes('code-cleanliness')).toBe(false);
    const moduleFiles = [
      '.claude/rules/code-cleanliness.md',
      '.claude/reference/design-principles.md',
      '.claude/skills/tidy/SKILL.md',
    ];

    expect(
      moduleFiles.filter((rel) => existsSync(join(root, rel))),
      'installed despite the module being off',
    ).toEqual([]);
  });

  describe('when enabled', () => {
    let root: string;

    beforeEach(() => {
      root = useInstalledRepo('pnpm-monorepo', { modules: 'code-cleanliness' });
    });

    it('installs the rule, a pull-only reference doc, and the tidy skill', () => {
      expect(
        existsSync(join(root, '.claude/rules/code-cleanliness.md')),
      ).toBeTruthy();
      expect(
        existsSync(join(root, '.claude/reference/design-principles.md')),
      ).toBeTruthy();
      expect(
        existsSync(join(root, '.claude/skills/tidy/SKILL.md')),
      ).toBeTruthy();
    });

    it('keeps the reference doc pull-only, with no paths: frontmatter, outside .claude/rules/', () => {
      const referenceText = readFileSync(
        join(root, '.claude/reference/design-principles.md'),
        'utf8',
      );
      expect(referenceText).not.toMatch(/^paths:/m);
      expect(existsSync(join(root, '.claude/rules/design-principles.md'))).toBe(
        false,
      );
      expect(referenceText).toMatch(
        /Duplication is far cheaper than the wrong abstraction/,
      );
    });

    it('states the tidy skill’s contract as rule-driven, not judgment-driven', () => {
      const skillText = readFileSync(
        join(root, '.claude/skills/tidy/SKILL.md'),
        'utf8',
      );
      expect(skillText).toMatch(/This is rule-driven, not judgment-driven/);
    });

    it('tracks the rule, reference doc, and skill as kit-owned in the manifest', () => {
      const manifest = manifestOf(root);
      expect(manifest.files['.claude/rules/code-cleanliness.md']).toBeTruthy();
      expect(
        manifest.files['.claude/reference/design-principles.md'],
      ).toBeTruthy();
      expect(manifest.files['.claude/skills/tidy/SKILL.md']).toBeTruthy();
    });
  });
});
