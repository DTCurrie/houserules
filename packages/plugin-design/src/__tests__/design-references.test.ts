import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { useInstalledRepo } from '#test/repo';
import { manifestOf, sha256 } from '#test/installed-tree';

const PLUGIN_DESIGN = fileURLToPath(new URL('../..', import.meta.url));
const PLUGINS = [{ name: PLUGIN_DESIGN, alias: 'design' }];

function installed(): string {
  return useInstalledRepo('pnpm-monorepo', {
    modules: 'design/design',
    plugins: PLUGINS,
  });
}

function readInstalledReference(root: string, name: string): string {
  return readFileSync(join(root, '.claude/reference', name), 'utf8');
}

function paragraphsOf(content: string): string[] {
  return content
    .split(/\n\n+/)
    .map((paragraph) => paragraph.replace(/\n/g, ' '));
}

function pairs44WithMinimumOutsideAAA(content: string): boolean {
  return paragraphsOf(content).some(
    (paragraph) =>
      paragraph.includes('44') &&
      (paragraph.includes('minimum') || paragraph.includes('floor')) &&
      !paragraph.includes('2.5.5'),
  );
}

describe('design layout and performance references', () => {
  it('installs both new reference docs with the design module', () => {
    const root = installed();

    expect(readInstalledReference(root, 'design-layout.md')).toContain(
      '## Container queries',
    );
    expect(readInstalledReference(root, 'design-performance.md')).toContain(
      'transform',
    );
  });

  it('records both new reference docs as kit-owned in the manifest', () => {
    const root = installed();

    const manifest = manifestOf(root);

    expect(manifest.files['.claude/reference/design-layout.md']).toBe(
      sha256(readFileSync(join(root, '.claude/reference/design-layout.md'))),
    );
    expect(manifest.files['.claude/reference/design-performance.md']).toBe(
      sha256(
        readFileSync(join(root, '.claude/reference/design-performance.md')),
      ),
    );
  });

  it("names both new reference filenames in the rule's routing table", () => {
    const root = installed();

    const ruleText = readFileSync(
      join(root, '.claude/rules/design.md'),
      'utf8',
    );

    expect(ruleText).toContain('design-layout.md');
    expect(ruleText).toContain('design-performance.md');
  });

  it('installs design-layout.md with no frontmatter, since it is pull-only', () => {
    const root = installed();

    expect(readInstalledReference(root, 'design-layout.md')).not.toMatch(
      /^---/,
    );
  });

  it('installs design-performance.md with no frontmatter, since it is pull-only', () => {
    const root = installed();

    expect(readInstalledReference(root, 'design-performance.md')).not.toMatch(
      /^---/,
    );
  });

  it('pairs every mention of 44 as a target size with WCAG 2.5.5, never presenting it as a floor', () => {
    const root = installed();

    const referenceDir = join(root, '.claude/reference');
    const rulesDir = join(root, '.claude/rules');
    const files = [
      ...readdirSync(referenceDir)
        .filter((name) => name.endsWith('.md'))
        .map((name) => join(referenceDir, name)),
      ...readdirSync(rulesDir)
        .filter((name) => name.endsWith('.md'))
        .map((name) => join(rulesDir, name)),
    ];

    const offenders = files.filter((path) => {
      const content = readFileSync(path, 'utf8');

      if (content.includes('44') && !content.includes('2.5.5')) return true;

      return pairs44WithMinimumOutsideAAA(content);
    });

    expect(
      offenders,
      'files presenting 44 as a floor rather than the AAA enhanced level',
    ).toEqual([]);
  });

  it('keeps design-performance.md scoped to design-time rendering cost, not bundle or infra topics', () => {
    const root = installed();

    const content = readInstalledReference(root, 'design-performance.md');

    expect(content).not.toContain('loading="lazy"');
    expect(content).not.toContain('code splitting');
  });

  it('names the current Core Web Vitals (LCP, CLS, INP) and the field p75 measurement in design-performance.md', () => {
    const root = installed();

    const content = readInstalledReference(root, 'design-performance.md');

    expect(content).toContain('LCP');
    expect(content).toContain('CLS');
    expect(content).toContain('INP');
    expect(content).toContain('75th percentile');
  });
});
