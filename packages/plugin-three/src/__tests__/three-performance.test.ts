import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { useInstalledRepo } from '#test/repo';
import { manifestOf, sha256 } from '#test/installed-tree';

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

    const content = readFileSync(referencePath(root), 'utf8');
    const manifest = manifestOf(root);

    expect(manifest.files['.claude/reference/three-performance.md']).toBe(
      sha256(content),
    );
  });

  it('does not claim WebGPU reached Baseline', () => {
    const root = installedWith(['performance']);

    const content = readFileSync(referencePath(root), 'utf8');

    expect(content).toContain('has not reached a Baseline classification');
    expect(content).not.toMatch(/percent.{0,10}global support/);
  });

  it('attributes the OffscreenCanvas global support figure to a named source', () => {
    const root = installedWith(['performance']);

    const content = readFileSync(referencePath(root), 'utf8');

    expect(content).toMatch(/global\s+support[\s\S]{0,40}per caniuse/i);
  });

  it('states the two-step Firefox WebGPU rollout on Apple Silicon macOS', () => {
    const root = installedWith(['performance']);

    const content = readFileSync(referencePath(root), 'utf8');

    expect(content).toContain('145');
    expect(content).toContain('147');
    expect(content).toMatch(/Intel Mac/);
    expect(content).toMatch(/Linux/);
  });

  it('treats the 100-draw-call figure as a prompt to investigate, not a threshold', () => {
    const root = installedWith(['performance']);

    const content = readFileSync(referencePath(root), 'utf8');

    expect(content).toContain(
      'roughly 100 draw calls per frame as a prompt to\ninvestigate rather than a hard threshold',
    );
  });

  it('does not attach a specific figure to Three.js-versus-framework or WebGPU-versus-WebGL benchmarks', () => {
    const root = installedWith(['performance']);

    const content = readFileSync(referencePath(root), 'utf8');

    expect(content).toContain('as\ndirectional at best');
    expect(content).not.toMatch(/benchmark[\s\S]{0,120}percent/);
  });

  it('tells the reader to recompute the bounding sphere after modifying vertices', () => {
    const root = installedWith(['performance']);

    const content = readFileSync(referencePath(root), 'utf8');

    expect(content).toContain(
      'Recompute that bounding sphere after modifying a mesh',
    );
  });
});
