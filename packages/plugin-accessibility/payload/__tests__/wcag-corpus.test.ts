import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { useInstalledRepo } from '#test/repo';
import { manifestOf } from '#test/installed-tree';

const PLUGIN_ACCESSIBILITY = fileURLToPath(new URL('../..', import.meta.url));
const PLUGINS = [{ name: PLUGIN_ACCESSIBILITY, alias: 'a11y' }];

function installedCorpus(): string {
  const root = useInstalledRepo('pnpm-monorepo', {
    modules: 'a11y/accessibility',
    plugins: PLUGINS,
  });
  return readFileSync(join(root, '.claude/reference/wcag22.md'), 'utf8');
}

function entryFor(corpus: string, number: string): string {
  const start = corpus.indexOf(`\n## ${number} `);
  const next = corpus.indexOf('\n## ', start + 1);
  return corpus.slice(start, next === -1 ? undefined : next);
}

describe('wcag22 reference corpus', () => {
  it('installs pull-only under .claude/reference/, never as an auto-loaded rule', () => {
    const root = useInstalledRepo('pnpm-monorepo', {
      modules: 'a11y/accessibility',
      plugins: PLUGINS,
    });

    const manifest = manifestOf(root);

    expect(manifest.files['.claude/reference/wcag22.md']).toBeTruthy();
    expect(manifest.files['.claude/rules/wcag22.md']).toBeFalsy();
  });

  it('carries the W3C attribution notice the Document License requires', () => {
    const corpus = installedCorpus();

    expect(corpus).toContain(
      'Copyright © 2023 W3C®. This software or document includes material copied from or derived from Web Content Accessibility Guidelines (WCAG) 2.2, https://www.w3.org/TR/WCAG22/.',
    );
    expect(corpus).toContain('https://www.w3.org/TR/WCAG22/');
    expect(corpus).toContain('WCAG22-20241212');
  });

  it('holds all 87 success criteria, each listed once in the index and once in full', () => {
    const corpus = installedCorpus();

    const headings = corpus.match(/^## \d+\.\d+\.\d+ /gm) ?? [];
    const indexLines = corpus.match(/^- \d+\.\d+\.\d+ /gm) ?? [];

    expect(headings).toHaveLength(87);
    expect(indexLines).toHaveLength(87);
  });

  it('numbers criteria by their position in the guideline structure', () => {
    const corpus = installedCorpus();

    expect(corpus).toMatch(/^## 1\.1\.1 Non-text Content$/m);
    expect(corpus).toMatch(/^## 1\.4\.3 Contrast \(Minimum\)$/m);
    expect(corpus).toMatch(/^## 2\.1\.1 Keyboard$/m);
    expect(corpus).toMatch(/^## 2\.5\.8 Target Size \(Minimum\)$/m);
    expect(corpus).toMatch(/^## 4\.1\.2 Name, Role, Value$/m);
  });

  it('gives each criterion its level, originating version, and spec URL', () => {
    const corpus = installedCorpus();

    expect(entryFor(corpus, '1.4.3')).toContain(
      '**Level AA** · WCAG 2.0 · https://www.w3.org/TR/WCAG22/#contrast-minimum',
    );
    expect(entryFor(corpus, '2.5.8')).toContain(
      '**Level AA** · WCAG 2.2 · https://www.w3.org/TR/WCAG22/#target-size-minimum',
    );
    expect(entryFor(corpus, '1.1.1')).toContain(
      '**Level A** · WCAG 2.0 · https://www.w3.org/TR/WCAG22/#non-text-content',
    );
  });

  it('marks 4.1.1 Parsing as removed so it does not read as an active requirement', () => {
    const corpus = installedCorpus();

    const parsing = entryFor(corpus, '4.1.1');

    expect(parsing).toContain('## 4.1.1 Parsing (Obsolete and removed)');
    expect(parsing).toContain('**Level Removed**');
  });

  it('converts the source HTML rather than embedding it', () => {
    const corpus = installedCorpus();

    expect(corpus).not.toMatch(/<\/?(?:p|a|dl|dt|dd|ul|li|section)\b/);
    expect(corpus).not.toContain('&amp;');
    expect(corpus).not.toContain('&nbsp;');
  });
});
