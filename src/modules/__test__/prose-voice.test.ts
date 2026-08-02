import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { useInstalledRepo } from '#test/repo';
import { manifestOf, settingsOf } from '#test/installed-tree';

function pathGlobs(ruleText: string): string[] {
  const body = ruleText.split('---')[1] ?? '';
  return [...body.matchAll(/^ {2}- ['"](.+?)['"]$/gm)].map((m) => m[1]);
}

describe('prose-voice', () => {
  it('installs a path-scoped rule that stays out of the always-loaded surface', () => {
    const root = useInstalledRepo('pnpm-monorepo', { modules: 'prose-voice' });

    const ruleText = readFileSync(
      join(root, '.claude/rules/prose-voice.md'),
      'utf8',
    );
    expect(
      ruleText,
      'without paths: frontmatter this rule loads on every turn',
    ).toMatch(/^---\n(?:.*\n)*?paths:\n/);
    expect(ruleText).toMatch(/^ {2}- ['"]\*\*\/\*\.md['"]$/m);
    expect(ruleText).toMatch(/^ {2}- ['"]\.changeset\/\*\.md['"]$/m);
    expect(ruleText).toMatch(/No semicolons/);

    const manifest = manifestOf(root);
    expect(manifest.modules.includes('prose-voice')).toBeTruthy();
    expect(
      manifest.files['.claude/rules/prose-voice.md'],
      'the rule is kit-owned (update-refreshable)',
    ).toBeTruthy();

    const settings = settingsOf(root);
    const cmds = Object.values(settings.hooks ?? {}).flatMap((groups: any) =>
      groups.flatMap((g: any) => g.hooks.map((h: any) => h.command)),
    );
    expect(cmds.some((c: string) => c.includes('prose-voice'))).toBe(false);
    expect(
      readFileSync(join(root, 'CLAUDE.md'), 'utf8').includes('prose-voice'),
    ).toBe(false);
  });

  it('covers every source extension code-comments defers to it for', () => {
    const root = useInstalledRepo('pnpm-monorepo', {
      modules: 'prose-voice,code-comments',
    });

    const voice = pathGlobs(
      readFileSync(join(root, '.claude/rules/prose-voice.md'), 'utf8'),
    );
    const comments = pathGlobs(
      readFileSync(join(root, '.claude/rules/code-comments.md'), 'utf8'),
    );

    expect(comments.length).toBeGreaterThan(0);
    expect(
      comments.filter((g) => !voice.includes(g)),
      'code-comments defers sentence voice to prose-voice, so a glob it matches without prose-voice matching leaves that pointer dangling',
    ).toEqual([]);
  });

  it('is not installed by default', () => {
    const root = useInstalledRepo('pnpm-monorepo');
    const manifest = manifestOf(root);
    expect(manifest.modules.includes('prose-voice')).toBe(false);
    expect(
      existsSync(join(root, '.claude/rules/prose-voice.md')),
      '.claude/rules/prose-voice.md absent',
    ).toBe(false);
  });
});
