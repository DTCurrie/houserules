import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { useInstalledRepo } from '#test/repo';
import { allHookCommands, manifestOf, sha256 } from '#test/installed-tree';

const PLUGIN_PROSE = fileURLToPath(new URL('../..', import.meta.url));
const PLUGINS = [{ name: PLUGIN_PROSE, alias: 'prose' }];

/** Mirrors the frontmatter/body cut the CLI's `body` action hashes separately. */
function splitFrontmatter(text: string): { frontmatter: string; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!match) return { frontmatter: '', body: text };
  return { frontmatter: match[0], body: text.slice(match[0].length) };
}

function pathGlobs(ruleText: string): string[] {
  const body = ruleText.split('---')[1] ?? '';
  return [...body.matchAll(/^ {2}- ['"](.+?)['"]$/gm)]
    .map((m) => m[1])
    .filter((glob): glob is string => glob !== undefined);
}

describe('prose-voice', () => {
  it('installs a path-scoped rule that stays out of the always-loaded surface', () => {
    const root = useInstalledRepo('pnpm-monorepo', {
      modules: 'prose/prose-voice',
      plugins: PLUGINS,
    });

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
    expect(manifest.modules.includes('prose/prose-voice')).toBe(true);
    const { frontmatter, body } = splitFrontmatter(ruleText);
    expect(
      manifest.files['.claude/rules/prose-voice.md'],
      'the rule BODY is kit-owned (update-refreshable)',
    ).toEqual({ body: sha256(body), frontmatter: sha256(frontmatter) });

    const cmds = allHookCommands(root);
    expect(cmds.some((c) => c.includes('prose-voice'))).toBe(false);
    expect(
      readFileSync(join(root, 'CLAUDE.md'), 'utf8').includes('prose-voice'),
    ).toBe(false);
  });

  it('covers every source extension code-comments defers to it for', () => {
    const root = useInstalledRepo('pnpm-monorepo', {
      modules: 'prose/prose-voice,prose/code-comments',
      plugins: PLUGINS,
    });

    const voice = pathGlobs(
      readFileSync(join(root, '.claude/rules/prose-voice.md'), 'utf8'),
    );
    const comments = pathGlobs(
      readFileSync(join(root, '.claude/rules/code-comments.md'), 'utf8'),
    );

    expect(comments).toHaveLength(10);
    expect(
      comments.filter((g) => !voice.includes(g)),
      'code-comments defers sentence voice to prose-voice, so a glob it matches without prose-voice matching leaves that pointer dangling',
    ).toEqual([]);
  });

  it('is not installed by default', () => {
    const root = useInstalledRepo('pnpm-monorepo', { plugins: PLUGINS });
    const manifest = manifestOf(root);
    expect(manifest.modules.includes('prose/prose-voice')).toBe(false);
    expect(
      existsSync(join(root, '.claude/rules/prose-voice.md')),
      '.claude/rules/prose-voice.md absent',
    ).toBe(false);
  });
});
