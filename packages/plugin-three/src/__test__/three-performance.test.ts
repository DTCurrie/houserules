import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { useInstalledRepo } from '#test/repo';
import { manifestOf } from '#test/installed-tree';

const PLUGIN_THREE = fileURLToPath(new URL('../..', import.meta.url));
const PLUGINS = [{ name: PLUGIN_THREE, alias: 'three' }];

function installedWith(guides: string[]): string {
  return useInstalledRepo('pnpm-monorepo', {
    modules: 'three/three',
    plugins: PLUGINS,
    ...(guides.length > 0 ? { moduleOptions: { 'three/three': guides } } : {}),
  });
}

function referencePath(root: string): string {
  return join(root, '.claude/reference/three-performance.md');
}

describe('three renderer performance reference', () => {
  it('is not installed by default', () => {
    const root = useInstalledRepo('pnpm-monorepo', { plugins: PLUGINS });

    expect(existsSync(referencePath(root))).toBe(false);
  });

  it('is not installed when the module is enabled with no options chosen', () => {
    const root = installedWith([]);

    expect(existsSync(referencePath(root))).toBe(false);
  });

  it('is installed when the performance option is chosen', () => {
    const root = installedWith(['performance']);

    const content = readFileSync(referencePath(root), 'utf8');
    expect(content).toContain('## Stop allocating inside the frame loop');
  });

  it('is not installed when only the threlte guide is chosen', () => {
    const root = installedWith(['threlte']);

    expect(existsSync(referencePath(root))).toBe(false);
  });

  it('is not installed when only the r3f guide is chosen', () => {
    const root = installedWith(['r3f']);

    expect(existsSync(referencePath(root))).toBe(false);
  });

  it('does not install the threlte guide when only performance is chosen', () => {
    const root = installedWith(['performance']);

    expect(existsSync(join(root, '.claude/rules/three-threlte.md'))).toBe(
      false,
    );
  });

  it('does not install the r3f guide when only performance is chosen', () => {
    const root = installedWith(['performance']);

    expect(existsSync(join(root, '.claude/rules/three-r3f.md'))).toBe(false);
  });

  it('carries no frontmatter, since it is pull-only', () => {
    const root = installedWith(['performance']);

    expect(readFileSync(referencePath(root), 'utf8')).not.toMatch(/^---/);
  });

  it('is tracked in the manifest as kit-owned', () => {
    const root = installedWith(['performance']);

    const manifest = manifestOf(root);

    expect(
      manifest.files['.claude/reference/three-performance.md'],
    ).toBeTruthy();
  });
});
