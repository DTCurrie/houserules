import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { useInstalledRepo } from '#test/repo';
import { manifestOf, sha256 } from '#test/installed-tree';

const PLUGIN_ACCESSIBILITY = fileURLToPath(new URL('../..', import.meta.url));
const PLUGINS = [{ name: PLUGIN_ACCESSIBILITY, alias: 'a11y' }];

const AGENT = '.claude/agents/accessibility-reviewer.md';
const SKILL = '.claude/skills/accessibility-review/SKILL.md';

function withReview(): string {
  return useInstalledRepo('pnpm-monorepo', {
    modules: 'a11y/accessibility,a11y/accessibility-review',
    plugins: PLUGINS,
  });
}

describe('accessibility-review', () => {
  it('installs the skill and the reviewer agent', () => {
    const root = withReview();

    const agent = readFileSync(join(root, AGENT), 'utf8');
    const skill = readFileSync(join(root, SKILL), 'utf8');
    const manifest = manifestOf(root);

    expect(manifest.modules.includes('a11y/accessibility-review')).toBe(true);
    expect(manifest.files[AGENT]).toBe(sha256(agent));
    expect(manifest.files[SKILL]).toBe(sha256(skill));
  });

  it('keeps the reviewer agent read-only', () => {
    const root = withReview();

    const agent = readFileSync(join(root, AGENT), 'utf8');

    expect(agent).toMatch(/^tools: Read, Grep, Glob, Bash$/m);
    expect(agent).not.toMatch(/^tools:.*(?:Write|Edit)/m);
  });

  it('routes through the script instead of reading the whole corpus', () => {
    const root = withReview();

    const skill = readFileSync(join(root, SKILL), 'utf8');
    const agent = readFileSync(join(root, AGENT), 'utf8');

    expect(skill).toContain('wcag.mjs applies');
    expect(agent).toContain('wcag.mjs applies');
    expect(
      `${skill}${agent}`,
      'reading the 838-line corpus whole defeats the whole design',
    ).toMatch(/never read|do not read|grep/i);
  });

  it('is not installed by default', () => {
    const root = useInstalledRepo('pnpm-monorepo', {
      modules: 'a11y/accessibility',
      plugins: PLUGINS,
    });

    expect(existsSync(join(root, AGENT))).toBe(false);
    expect(existsSync(join(root, SKILL))).toBe(false);
  });
});
