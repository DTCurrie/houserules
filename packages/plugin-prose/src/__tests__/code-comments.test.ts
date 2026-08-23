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

describe('code-comments', () => {
  it('installs a path-scoped rule that stays out of the always-loaded surface', () => {
    const root = useInstalledRepo('pnpm-monorepo', {
      modules: 'prose/code-comments',
      plugins: PLUGINS,
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
    expect(manifest.modules.includes('prose/code-comments')).toBe(true);
    const { frontmatter, body } = splitFrontmatter(ruleText);
    expect(
      manifest.files['.claude/rules/code-comments.md'],
      'the rule BODY is kit-owned (update-refreshable)',
    ).toEqual({ body: sha256(body), frontmatter: sha256(frontmatter) });

    const cmds = allHookCommands(root);
    expect(cmds.some((c) => c.includes('code-comments'))).toBe(false);
    expect(
      readFileSync(join(root, 'CLAUDE.md'), 'utf8').includes('code-comments'),
    ).toBe(false);
  });

  it('is not installed by default', () => {
    const root = useInstalledRepo('pnpm-monorepo', { plugins: PLUGINS });
    const manifest = manifestOf(root);
    expect(manifest.modules.includes('prose/code-comments')).toBe(false);
    expect(
      existsSync(join(root, '.claude/rules/code-comments.md')),
      '.claude/rules/code-comments.md absent',
    ).toBe(false);
  });
});
