import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { useInstalledRepo } from '#test/repo';
import { manifestOf } from '#test/installed-tree';

const PLUGIN_THREE = fileURLToPath(new URL('../..', import.meta.url));
const PLUGINS = [{ name: PLUGIN_THREE, alias: 'three' }];

const RULE_PATH = '.claude/rules/three.md';
const REFERENCE_PATH = '.claude/reference/three-upstream-docs.md';

function referenceLinksIn(ruleText: string): string[] {
  return [...ruleText.matchAll(/`(\.\.\/reference\/[^`]+\.md)`/g)].map(
    (match) => match[1],
  );
}

describe('three upstream docs reference', () => {
  it('installs with the base module when no options are chosen', () => {
    const root = useInstalledRepo('pnpm-monorepo', {
      modules: 'three/three',
      plugins: PLUGINS,
    });

    const content = readFileSync(join(root, REFERENCE_PATH), 'utf8');

    expect(content).toContain('https://threejs.org/docs/llms.txt');
  });

  it('is not installed when the three module is not enabled', () => {
    const root = useInstalledRepo('pnpm-monorepo', { plugins: PLUGINS });

    expect(existsSync(join(root, REFERENCE_PATH))).toBe(false);
  });

  it('carries no frontmatter, since it is pull-only', () => {
    const root = useInstalledRepo('pnpm-monorepo', {
      modules: 'three/three',
      plugins: PLUGINS,
    });

    expect(readFileSync(join(root, REFERENCE_PATH), 'utf8')).not.toMatch(
      /^---/,
    );
  });

  it('is tracked in the manifest as kit-owned', () => {
    const root = useInstalledRepo('pnpm-monorepo', {
      modules: 'three/three',
      plugins: PLUGINS,
    });

    expect(manifestOf(root).files[REFERENCE_PATH]).toBeTruthy();
  });

  it('is installed for every reference link the base rule points at', () => {
    const root = useInstalledRepo('pnpm-monorepo', {
      modules: 'three/three',
      plugins: PLUGINS,
    });
    const rulePath = join(root, RULE_PATH);

    const resolution = referenceLinksIn(readFileSync(rulePath, 'utf8')).map(
      (link) => ({
        link,
        installed: existsSync(resolve(dirname(rulePath), link)),
      }),
    );

    expect(resolution).toEqual([
      { link: '../reference/three-upstream-docs.md', installed: true },
      { link: '../reference/three-debugging.md', installed: true },
    ]);
  });

  it('links the performance reference too when the performance option is chosen', () => {
    const root = useInstalledRepo('pnpm-monorepo', {
      modules: 'three/three',
      plugins: PLUGINS,
      moduleOptions: { 'three/three': ['performance'] },
    });
    const rulePath = join(root, RULE_PATH);

    const resolution = referenceLinksIn(readFileSync(rulePath, 'utf8')).map(
      (link) => ({
        link,
        installed: existsSync(resolve(dirname(rulePath), link)),
      }),
    );

    expect(resolution).toEqual([
      { link: '../reference/three-upstream-docs.md', installed: true },
      { link: '../reference/three-debugging.md', installed: true },
      { link: '../reference/three-performance.md', installed: true },
    ]);
  });
});
