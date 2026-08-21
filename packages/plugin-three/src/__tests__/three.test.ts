import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { useInstalledRepo } from '#test/repo';
import { manifestOf } from '#test/installed-tree';

const PLUGIN_THREE = fileURLToPath(new URL('../..', import.meta.url));
const PLUGINS = [{ name: PLUGIN_THREE, alias: 'three' }];

function pathGlobs(ruleText: string): string[] {
  const body = ruleText.split('---')[1] ?? '';
  return [...body.matchAll(/^ {2}- ['"](.+?)['"]$/gm)]
    .map((m) => m[1])
    .filter((glob): glob is string => glob !== undefined);
}

function installedWith(guides: string[]): string {
  return useInstalledRepo('pnpm-monorepo', {
    modules: 'three/three',
    plugins: PLUGINS,
    ...(guides.length > 0 ? { moduleOptions: { 'three/three': guides } } : {}),
  });
}

function guidePath(root: string, guide: string): string {
  return join(root, `.claude/rules/three-${guide}.md`);
}

describe('three', () => {
  it('installs the base rule path-scoped and tracks it in the manifest', () => {
    const root = installedWith([]);

    const ruleText = readFileSync(join(root, '.claude/rules/three.md'), 'utf8');
    expect(
      ruleText,
      'without paths: frontmatter this rule loads on every turn',
    ).toMatch(/^---\n(?:.*\n)*?paths:\n/);
    expect(pathGlobs(ruleText)).toEqual([
      '**/three/**',
      '**/*.three.ts',
      '**/*.glsl',
      '**/*.wgsl',
    ]);

    const manifest = manifestOf(root);
    expect(manifest.modules.includes('three/three')).toBeTruthy();
    expect(
      manifest.files['.claude/rules/three.md'],
      'the rule BODY is kit-owned (update-refreshable)',
    ).toBeTruthy();
  });

  it('teaches disposal ownership for geometries, materials, and textures', () => {
    const root = installedWith([]);

    const ruleText = readFileSync(join(root, '.claude/rules/three.md'), 'utf8');

    expect(ruleText).toContain('.dispose()');
    expect(ruleText).toContain('Object3D` is cheap');
  });

  it('links the debugging reference from the base rule and installs it', () => {
    const root = installedWith([]);

    const ruleText = readFileSync(join(root, '.claude/rules/three.md'), 'utf8');

    expect(ruleText).toContain('../reference/three-debugging.md');
    expect(existsSync(join(root, '.claude/reference/three-debugging.md'))).toBe(
      true,
    );
  });

  it('imports LineSegments2 from the three/addons/ alias', () => {
    const root = installedWith([]);

    const ruleText = readFileSync(join(root, '.claude/rules/three.md'), 'utf8');

    expect(ruleText).toContain(
      "import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';",
    );
  });

  it('is not installed by default', () => {
    const root = useInstalledRepo('pnpm-monorepo', { plugins: PLUGINS });

    const manifest = manifestOf(root);
    expect(manifest.modules.includes('three/three')).toBe(false);
    expect(existsSync(join(root, '.claude/rules/three.md'))).toBe(false);
  });

  it('installs only the guides that were chosen', () => {
    const root = installedWith(['threlte']);

    expect(existsSync(guidePath(root, 'threlte'))).toBe(true);
    expect(existsSync(guidePath(root, 'r3f'))).toBe(false);
  });

  it('installs no guide when none was chosen', () => {
    const root = installedWith([]);

    expect(existsSync(guidePath(root, 'threlte'))).toBe(false);
    expect(existsSync(guidePath(root, 'r3f'))).toBe(false);
  });

  it('ships upstream docs without any binding section when no guide was chosen', () => {
    const root = installedWith([]);

    const docs = readFileSync(
      join(root, '.claude/reference/three-upstream-docs.md'),
      'utf8',
    );

    expect(docs).not.toContain('Framework bindings installed in this repo');
    expect(docs).not.toContain('React Three Fiber');
    expect(docs).not.toContain('Threlte');
    expect(
      existsSync(
        join(root, '.claude/reference/three-upstream-docs-threlte.md'),
      ),
    ).toBe(false);
    expect(
      existsSync(join(root, '.claude/reference/three-upstream-docs-r3f.md')),
    ).toBe(false);
  });

  it('links only the Threlte docs for a threlte-only install, with no R3F mention anywhere', () => {
    const root = installedWith(['threlte']);

    const docs = readFileSync(
      join(root, '.claude/reference/three-upstream-docs.md'),
      'utf8',
    );

    expect(docs).toContain(
      'Threlte: `three-upstream-docs-threlte.md` beside this file.',
    );
    expect(docs).not.toContain('React Three Fiber');
    expect(
      existsSync(
        join(root, '.claude/reference/three-upstream-docs-threlte.md'),
      ),
    ).toBe(true);
    expect(
      existsSync(join(root, '.claude/reference/three-upstream-docs-r3f.md')),
    ).toBe(false);
  });

  it('links only the R3F docs for an r3f-only install, with no Threlte mention anywhere', () => {
    const root = installedWith(['r3f']);

    const docs = readFileSync(
      join(root, '.claude/reference/three-upstream-docs.md'),
      'utf8',
    );

    expect(docs).toContain(
      'React Three Fiber: `three-upstream-docs-r3f.md` beside this file.',
    );
    expect(docs).not.toContain('Threlte');
    expect(
      existsSync(join(root, '.claude/reference/three-upstream-docs-r3f.md')),
    ).toBe(true);
    expect(
      existsSync(
        join(root, '.claude/reference/three-upstream-docs-threlte.md'),
      ),
    ).toBe(false);
  });

  it('links both docs files, Threlte first, when both guides are chosen', () => {
    const root = installedWith(['r3f', 'threlte']);

    const docs = readFileSync(
      join(root, '.claude/reference/three-upstream-docs.md'),
      'utf8',
    );

    expect(docs).toContain(
      '- Threlte: `three-upstream-docs-threlte.md` beside this file.\n' +
        '- React Three Fiber: `three-upstream-docs-r3f.md` beside this file.',
    );
  });

  it('keeps every guide glob covered by the base rule globs', () => {
    const root = installedWith(['threlte', 'r3f']);
    const baseGlobs = pathGlobs(
      readFileSync(join(root, '.claude/rules/three.md'), 'utf8'),
    );
    const baseDirGlob = baseGlobs.find((glob) => glob.endsWith('/**'));

    expect(
      baseDirGlob,
      'the base rule must ship a directory glob for a guide glob to nest under',
    ).toBeDefined();

    const uncovered = ['threlte', 'r3f'].flatMap((guide) =>
      pathGlobs(readFileSync(guidePath(root, guide), 'utf8'))
        .filter((glob) => !glob.startsWith(baseDirGlob!.slice(0, -1)))
        .map((glob) => `${guide}: ${glob}`),
    );

    expect(
      uncovered,
      'a guide loaded on a file where the base rule is absent defers to a rule that is not in context',
    ).toEqual([]);
  });
});
