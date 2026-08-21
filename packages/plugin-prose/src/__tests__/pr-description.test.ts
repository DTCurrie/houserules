import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { useInstalledRepo } from '#test/repo';
import { allHookCommands, manifestOf } from '#test/installed-tree';

const PLUGIN_PROSE = fileURLToPath(new URL('../..', import.meta.url));
const PLUGINS = [{ name: PLUGIN_PROSE, alias: 'prose' }];

const SKILL_PATH = '.claude/skills/pr-description/SKILL.md';

function installed(): string {
  return useInstalledRepo('pnpm-monorepo', {
    modules: 'prose/pr-description',
    plugins: PLUGINS,
  });
}

function frontmatter(text: string): string {
  return text.split('---')[1] ?? '';
}

describe('pr-description', () => {
  it('installs the skill and tracks it in the manifest', () => {
    const root = installed();

    expect(existsSync(join(root, SKILL_PATH))).toBe(true);

    const manifest = manifestOf(root);
    expect(manifest.modules.includes('prose/pr-description')).toBeTruthy();
    expect(manifest.files[SKILL_PATH]).toBeTruthy();
  });

  it('carries the routing terms a request for a PR body would use', () => {
    const root = installed();

    const description = frontmatter(
      readFileSync(join(root, SKILL_PATH), 'utf8'),
    );
    expect(description).toMatch(/pull request/i);
    expect(description).toMatch(/PR body/i);
    expect(description).toMatch(/gh pr create/);
  });

  it('tells the reader to write from the diff rather than the session', () => {
    const root = installed();

    const body = readFileSync(join(root, SKILL_PATH), 'utf8');
    expect(body).toMatch(/git diff --name-only/);
    expect(body).toMatch(/Do not write from memory of the session/);
  });

  it('names no framework-specific layer as required', () => {
    const root = installed();

    const body = readFileSync(join(root, SKILL_PATH), 'utf8');
    expect(
      body,
      'the layer vocabulary is per-repo, so the skill must not hardcode one',
    ).toMatch(/architecture layers \*\*this repo actually has\*\*/);
    expect(body).not.toMatch(/\.svelte/);
  });

  it('adds nothing to the always-loaded surface', () => {
    const root = installed();

    const commands = allHookCommands(root);
    expect(commands.some((c) => c.includes('pr-description'))).toBe(false);
    expect(
      readFileSync(join(root, 'CLAUDE.md'), 'utf8').includes('pr-description'),
    ).toBe(false);
    expect(existsSync(join(root, '.claude/rules/pr-description.md'))).toBe(
      false,
    );
  });

  it('is not installed by default', () => {
    const root = useInstalledRepo('pnpm-monorepo', { plugins: PLUGINS });

    const manifest = manifestOf(root);
    expect(manifest.modules.includes('prose/pr-description')).toBe(false);
    expect(existsSync(join(root, SKILL_PATH))).toBe(false);
  });
});
