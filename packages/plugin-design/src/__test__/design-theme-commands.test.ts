import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadDesignSystem } from '../../payload/scripts/lib/tailwind-design-system.mts';
import { useBareRepo, useTailwindRepo } from '#test/tailwind-fixture';

const DESIGN_SCRIPT = fileURLToPath(
  new URL('../../payload-dist/scripts/design.mjs', import.meta.url),
);

const TWO_SHADE_ENTRY_CSS = `@import "tailwindcss";

@theme {
  --color-brand-400: oklch(0.7 0.15 265);
  --color-brand-600: oklch(0.4 0.2 265);
}
`;

function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.NODE_PATH;
  return env;
}

function design(root: string, ...args: string[]) {
  return spawnSync(process.execPath, [DESIGN_SCRIPT, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: cleanEnv(),
  });
}

function snapshotTree(root: string): string[] {
  const top = readdirSync(root)
    .filter((name) => name !== 'node_modules')
    .sort();
  const src = readdirSync(join(root, 'src')).sort();
  return [...top, ...src.map((name) => `src/${name}`)];
}

describe('design.mjs theme', () => {
  it('marks a repo-declared color as repo and a Tailwind default as default', () => {
    const root = useTailwindRepo();

    const result = design(root, 'theme', '--all');

    expect(result.status).toBe(0);
    // Asserted as the isolated line rather than with toContain, so a failure prints the line it
    // actually got. toContain against thousands of lines of Tailwind defaults reports only that
    // the needle was absent, which cannot distinguish a missing token from a reformatted one.
    const brandLine = result.stdout
      .split('\n')
      .find((line) => line.includes('brand-500'));
    expect(brandLine).toBe('  brand-500  oklch(0.55, 0.2, 265)  (repo)');
    expect(result.stdout).toMatch(/\n {2}\S+ {2}.+ {2}\(default\)\n/);
  });

  it('hides Tailwind defaults by default, summarizing how many were hidden', () => {
    const root = useTailwindRepo();

    const result = design(root, 'theme');

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      'color:\n  brand-500  oklch(0.55, 0.2, 265)\n',
    );
    expect(result.stdout).toContain('fontSize:\n  hero  3rem\n');
    expect(result.stdout).toMatch(
      /\d+ more from Tailwind's defaults, not shown\. Run with --all to see them\./,
    );
    expect(result.stdout).not.toMatch(/\(default\)/);
  });

  it('exits non-zero on a repo with no Tailwind entry stylesheet', () => {
    const root = useBareRepo();

    const result = design(root, 'theme');

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('@import "tailwindcss"');
  });

  it('refuses to read a token file instead of a Tailwind theme', () => {
    const root = useBareRepo();
    mkdirSync(join(root, '.claude/design'), { recursive: true });
    writeFileSync(join(root, '.claude/design/tokens.json'), '{}');

    const result = design(
      root,
      '--tokens',
      '.claude/design/tokens.json',
      'theme',
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('design.mjs theme reads a Tailwind theme');
  });
});

describe('design.mjs scaffold', () => {
  it('names a single-shade color as one role, under @theme inline', () => {
    const root = useTailwindRepo();

    const result = design(root, 'scaffold');

    expect(result.status).toBe(0);
    expect(result.stdout).toBe(
      '@theme inline {\n' +
        '  /* inline, so each role reads its underlying variable directly instead of freezing it at :root. */\n' +
        '  --color-brand: var(--color-brand-500);\n' +
        '}\n',
    );
  });

  it('creates no file', () => {
    const root = useTailwindRepo();
    const before = snapshotTree(root);
    const cssBefore = readFileSync(join(root, 'src/app.css'), 'utf8');

    const result = design(root, 'scaffold');

    expect(result.status).toBe(0);
    expect(snapshotTree(root)).toEqual(before);
    expect(readFileSync(join(root, 'src/app.css'), 'utf8')).toBe(cssBefore);
  });

  it('names a two-shade base with a lightest role and a raised role, not the shade numbers', () => {
    const root = useTailwindRepo({ css: TWO_SHADE_ENTRY_CSS });

    const result = design(root, 'scaffold');

    expect(result.status).toBe(0);
    expect(result.stdout).toBe(
      '@theme inline {\n' +
        '  /* inline, so each role reads its underlying variable directly instead of freezing it at :root. */\n' +
        '  --color-brand: var(--color-brand-400);\n' +
        '  --color-brand-raised: var(--color-brand-600);\n' +
        '}\n',
    );
    expect(result.stdout).not.toMatch(/--color-brand-400:/);
    expect(result.stdout).not.toMatch(/--color-brand-600:/);
  });

  it('exits non-zero on a repo with no Tailwind entry stylesheet', () => {
    const root = useBareRepo();

    const result = design(root, 'scaffold');

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('@import "tailwindcss"');
  });

  it('produces a block Tailwind accepts with no unresolved reference', async () => {
    const root = useTailwindRepo({ css: TWO_SHADE_ENTRY_CSS });
    const cssPath = join(root, 'src/app.css');
    const scaffolded = design(root, 'scaffold');

    writeFileSync(cssPath, `${TWO_SHADE_ENTRY_CSS}\n${scaffolded.stdout}`);
    const result = await loadDesignSystem(root, cssPath);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.theme.get(['--color-brand-raised'])).toBe(
      'var(--color-brand-600)',
    );
    expect(result.value.theme.get(['--color-brand-600'])).toBe(
      'oklch(0.4 0.2 265)',
    );
  });

  it('compiles a role utility straight to the underlying variable, declaring no frozen alias', async () => {
    const root = useTailwindRepo();
    const cssPath = join(root, 'src/app.css');
    const entryCss = readFileSync(cssPath, 'utf8');
    const scaffolded = design(root, 'scaffold');

    writeFileSync(cssPath, `${entryCss}\n${scaffolded.stdout}`);
    const result = await loadDesignSystem(root, cssPath);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [css] = result.value.candidatesToCss(['bg-brand']);
    expect(css).toContain('var(--color-brand-500)');
    expect(css).not.toContain('var(--color-brand)');
  });
});
