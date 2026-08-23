import { beforeEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { useInstalledRepo } from '#test/repo';
import { allHookCommands, manifestOf, sha256 } from '#test/installed-tree';
import { splitFrontmatter } from '../../core/frontmatter.js';

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
    expect(
      ruleText,
      'the line count is a prompt to look, not a target to hit',
    ).toMatch(/Past 20 to 30 lines, look again/);
    expect(ruleText).not.toMatch(/Target under 20 to 30 lines/);

    const manifest = manifestOf(root);
    expect(manifest.modules.includes('code-cleanliness')).toBe(true);
    const { frontmatter, body } = splitFrontmatter(ruleText);
    expect(
      manifest.files['.claude/rules/code-cleanliness.md'],
      'the rule BODY is kit-owned (update-refreshable)',
    ).toEqual({
      frontmatter: sha256(frontmatter),
      body: sha256(body),
    });

    const cmds = allHookCommands(root);
    expect(cmds.some((c) => c.includes('code-cleanliness'))).toBe(false);
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
      expect(existsSync(join(root, '.claude/rules/code-cleanliness.md'))).toBe(
        true,
      );
      expect(
        existsSync(join(root, '.claude/reference/design-principles.md')),
      ).toBe(true);
      expect(existsSync(join(root, '.claude/skills/tidy/SKILL.md'))).toBe(true);
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
      expect(
        referenceText,
        'deep modules is the fuller reasoning behind the function-size line in code-cleanliness.md',
      ).toMatch(
        /deep module, a simple interface hiding substantial functionality/,
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
      const rule = splitFrontmatter(
        readFileSync(join(root, '.claude/rules/code-cleanliness.md'), 'utf8'),
      );
      expect(manifest.files['.claude/rules/code-cleanliness.md']).toEqual({
        frontmatter: sha256(rule.frontmatter),
        body: sha256(rule.body),
      });
      expect(manifest.files['.claude/reference/design-principles.md']).toBe(
        sha256(
          readFileSync(
            join(root, '.claude/reference/design-principles.md'),
            'utf8',
          ),
        ),
      );
      expect(manifest.files['.claude/skills/tidy/SKILL.md']).toBe(
        sha256(
          readFileSync(join(root, '.claude/skills/tidy/SKILL.md'), 'utf8'),
        ),
      );
    });
  });
});
