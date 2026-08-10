import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { useInstalledRepo } from '#test/repo';
import { manifestOf, settingsOf } from '#test/installed-tree';

const PLUGIN_TYPESCRIPT = fileURLToPath(new URL('../..', import.meta.url));
const PLUGINS = [{ name: PLUGIN_TYPESCRIPT, alias: 'ts' }];

describe('typescript', () => {
  it('installs a path-scoped rule that stays out of the always-loaded surface', () => {
    const root = useInstalledRepo('pnpm-monorepo', {
      modules: 'ts/typescript',
      plugins: PLUGINS,
    });

    const ruleText = readFileSync(
      join(root, '.claude/rules/typescript.md'),
      'utf8',
    );
    expect(
      ruleText,
      'without paths: frontmatter this rule loads on every turn',
    ).toMatch(/^---\n(?:.*\n)*?paths:\n/);
    expect(ruleText).toMatch(/^ {2}- ['"]\*\*\/\*\.ts['"]$/m);
    expect(ruleText).toMatch(/^ {2}- ['"]\*\*\/\*\.mts['"]$/m);
    expect(ruleText).toMatch(/^ {2}- ['"]\*\*\/\*\.cts['"]$/m);
  });

  it('covers every extension a rule deferring to it can be loaded on', () => {
    const root = useInstalledRepo('pnpm-monorepo', {
      modules: 'ts/typescript',
      plugins: PLUGINS,
    });

    const ruleText = readFileSync(
      join(root, '.claude/rules/typescript.md'),
      'utf8',
    );
    const globs = [...ruleText.matchAll(/^ {2}- ['"](.+?)['"]$/gm)].map(
      (match) => match[1],
    );
    const missing = ['**/*.tsx', '**/*.svelte', '**/*.svelte.ts'].filter(
      (glob) => !globs.includes(glob),
    );

    expect(
      missing,
      'svelte.md defers here, so a file it loads on without this rule leaves that pointer dangling',
    ).toEqual([]);

    const manifest = manifestOf(root);
    expect(manifest.modules.includes('ts/typescript')).toBeTruthy();
    expect(
      manifest.files['.claude/rules/typescript.md'],
      'the rule BODY is kit-owned (update-refreshable)',
    ).toBeTruthy();
  });

  it('is not installed by default', () => {
    const root = useInstalledRepo('pnpm-monorepo', { plugins: PLUGINS });
    const manifest = manifestOf(root);
    expect(manifest.modules.includes('ts/typescript')).toBe(false);
    expect(
      existsSync(join(root, '.claude/rules/typescript.md')),
      '.claude/rules/typescript.md absent',
    ).toBe(false);
  });

  it('does not restate doc-comment guidance code-comments.md already owns', () => {
    const root = useInstalledRepo('pnpm-monorepo', {
      modules: 'ts/typescript',
      plugins: PLUGINS,
    });

    const ruleText = readFileSync(
      join(root, '.claude/rules/typescript.md'),
      'utf8',
    );
    expect(ruleText).not.toMatch(/TSDoc/);
    expect(ruleText).not.toMatch(/[Dd]oc [Cc]omment/);
  });

  it("does not restate the CLAUDE.md managed region's verification commands", () => {
    const root = useInstalledRepo('pnpm-monorepo', {
      modules: 'ts/typescript',
      plugins: PLUGINS,
    });

    const ruleText = readFileSync(
      join(root, '.claude/rules/typescript.md'),
      'utf8',
    );
    expect(ruleText).not.toMatch(/Verify Your Work/);
    expect(ruleText).not.toMatch(/pnpm check/);
  });

  it('adds nothing to CLAUDE.md or the hook set', () => {
    const root = useInstalledRepo('pnpm-monorepo', {
      modules: 'ts/typescript',
      plugins: PLUGINS,
    });

    const settings = settingsOf(root);
    const cmds = Object.values(settings.hooks ?? {}).flatMap((groups: any) =>
      groups.flatMap((g: any) => g.hooks.map((h: any) => h.command)),
    );
    expect(cmds.some((c: string) => c.includes('typescript'))).toBe(false);
    expect(
      readFileSync(join(root, 'CLAUDE.md'), 'utf8').includes('typescript'),
    ).toBe(false);
  });

  it('requires a never-typed default branch for exhaustive switches', () => {
    const root = useInstalledRepo('pnpm-monorepo', {
      modules: 'ts/typescript',
      plugins: PLUGINS,
    });

    const ruleText = readFileSync(
      join(root, '.claude/rules/typescript.md'),
      'utf8',
    );
    expect(ruleText).toMatch(/default.*branch typed\s*\n?\s*`never`/);
  });

  it('prefers @ts-expect-error over @ts-ignore', () => {
    const root = useInstalledRepo('pnpm-monorepo', {
      modules: 'ts/typescript',
      plugins: PLUGINS,
    });

    const ruleText = readFileSync(
      join(root, '.claude/rules/typescript.md'),
      'utf8',
    );
    expect(ruleText).toMatch(/`@ts-expect-error`, not `@ts-ignore`/);
  });

  it('requires Error.cause when rethrowing with added context', () => {
    const root = useInstalledRepo('pnpm-monorepo', {
      modules: 'ts/typescript',
      plugins: PLUGINS,
    });

    const ruleText = readFileSync(
      join(root, '.claude/rules/typescript.md'),
      'utf8',
    );
    expect(ruleText).toMatch(/Rethrow with `cause`/);
    expect(ruleText).toMatch(/\{ cause: err \}/);
  });

  it('enumerates every extension the rule frontmatter globs, in both the README and the advise text', () => {
    const ruleSource = readFileSync(
      join(PLUGIN_TYPESCRIPT, 'payload/rules/typescript.md'),
      'utf8',
    );
    const globs = [...ruleSource.matchAll(/^ {2}- ['"](.+?)['"]$/gm)].map(
      (match) => match[1],
    );
    const extensions = globs.map((glob) => glob.replace(/^\*\*\/\*/, ''));

    expect(extensions.length).toBeGreaterThan(0);

    const indexSource = readFileSync(
      join(PLUGIN_TYPESCRIPT, 'src/index.ts'),
      'utf8',
    );
    const readmeSource = readFileSync(
      join(PLUGIN_TYPESCRIPT, 'README.md'),
      'utf8',
    );

    const missingFromIndex = extensions.filter(
      (ext) => !globAppearsIn(indexSource, ext),
    );
    const missingFromReadme = extensions.filter(
      (ext) => !globAppearsIn(readmeSource, ext),
    );

    expect(
      missingFromIndex,
      'src/index.ts advise text omits an extension the rule frontmatter globs',
    ).toEqual([]);
    expect(
      missingFromReadme,
      'README.md omits an extension the rule frontmatter globs',
    ).toEqual([]);
  });
});

function globAppearsIn(source: string, extension: string): boolean {
  const escaped = extension.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\*\\*/\\*${escaped}(?![A-Za-z])`).test(source);
}
