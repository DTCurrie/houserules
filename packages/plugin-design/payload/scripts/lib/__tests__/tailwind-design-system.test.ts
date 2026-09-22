import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, onTestFinished } from 'vitest';

import {
  findThemeEntryCss,
  isRepoDefinedThemeKey,
  loadDesignSystem,
  loadFirstCompilingDesignSystem,
} from '../tailwind-design-system.mts';
import {
  addPackage,
  DEFAULT_ENTRY_CSS,
  useBareRepo,
  useTailwindRepo,
} from '#test/tailwind-fixture';

function writeCssFile(dir: string, name: string, text: string): string {
  const path = join(dir, name);
  writeFileSync(path, text);
  return path;
}

function tempCssDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'theme-entry-'));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function chmodMakesFileUnreadable(): boolean {
  const dir = mkdtempSync(join(tmpdir(), 'theme-entry-chmod-'));
  const probe = writeCssFile(dir, 'probe.css', 'x');
  chmodSync(probe, 0o000);
  try {
    readFileSync(probe, 'utf8');
    return false;
  } catch {
    return true;
  } finally {
    chmodSync(probe, 0o644);
    rmSync(dir, { recursive: true, force: true });
  }
}

const CHMOD_ENFORCES_UNREADABLE = chmodMakesFileUnreadable();

describe('loadDesignSystem', () => {
  it('reports a repo theme with more than 400 entries', async () => {
    const root = useTailwindRepo();

    const result = await loadDesignSystem(root, join(root, 'src/app.css'));

    expect(result.ok, result.ok ? '' : result.error).toBe(true);
    if (!result.ok) return;
    expect(result.value.theme.size).toBeGreaterThan(400);
  });

  it('reads the repo-declared brand color out of the theme', async () => {
    const root = useTailwindRepo();

    const result = await loadDesignSystem(root, join(root, 'src/app.css'));

    expect(result.ok, result.ok ? '' : result.error).toBe(true);
    if (!result.ok) return;
    expect(result.value.theme.get(['--color-brand-500'])).toBe(
      'oklch(0.55 0.2 265)',
    );
  });

  it('compiles a spacing utility to a calc() expression against the repo spacing scale', async () => {
    const root = useTailwindRepo();

    const result = await loadDesignSystem(root, join(root, 'src/app.css'));

    expect(result.ok, result.ok ? '' : result.error).toBe(true);
    if (!result.ok) return;
    const [css] = result.value.candidatesToCss(['p-3']);
    expect(css).toContain('calc(var(--spacing) * 3)');
  });

  it('resolves an unrecognized candidate to null', async () => {
    const root = useTailwindRepo();

    const result = await loadDesignSystem(root, join(root, 'src/app.css'));

    expect(result.ok, result.ok ? '' : result.error).toBe(true);
    if (!result.ok) return;
    expect(result.value.candidatesToCss(['not-a-real-class'])).toEqual([null]);
  });

  it('fails with the install command and no stack trace when tailwindcss is not installed', async () => {
    const root = useBareRepo();
    writeFileSync(join(root, 'app.css'), '@import "tailwindcss";');

    const result = await loadDesignSystem(root, join(root, 'app.css'));

    expect(result.ok, result.ok ? '' : result.error).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe(
      `tailwindcss is not installed in ${root}. Install it in that repo with \`npm install -D tailwindcss@4\`.`,
    );
  });

  it('resolves a tokens package imported by name through its exports style condition', async () => {
    const root = useTailwindRepo({
      css: '@import "tailwindcss";\n@import "@acme/tailwind-config";\n',
    });
    addPackage(
      root,
      '@acme/tailwind-config',
      { exports: { '.': { style: './tokens.css' } } },
      { 'tokens.css': '@theme {\n  --color-acme-500: #123456;\n}\n' },
    );

    const result = await loadDesignSystem(root, join(root, 'src/app.css'));

    expect(result.ok, result.ok ? '' : result.error).toBe(true);
    if (!result.ok) return;
    expect(result.value.theme.get(['--color-acme-500'])).toBe('#123456');
  });

  it('resolves a tokens package that declares only a style field', async () => {
    const root = useTailwindRepo({
      css: '@import "tailwindcss";\n@import "acme-tokens";\n',
    });
    addPackage(
      root,
      'acme-tokens',
      { style: 'theme/main.css' },
      { 'theme/main.css': '@theme {\n  --color-acme-700: #654321;\n}\n' },
    );

    const result = await loadDesignSystem(root, join(root, 'src/app.css'));

    expect(result.ok, result.ok ? '' : result.error).toBe(true);
    if (!result.ok) return;
    expect(result.value.theme.get(['--color-acme-700'])).toBe('#654321');
  });

  it('resolves a package subpath import, appending .css when the literal path is not a file', async () => {
    const root = useTailwindRepo({
      css: '@import "tailwindcss";\n@import "@acme/tailwind-config/colors";\n',
    });
    addPackage(
      root,
      '@acme/tailwind-config',
      {},
      { 'colors.css': '@theme {\n  --color-acme-100: #abcdef;\n}\n' },
    );

    const result = await loadDesignSystem(root, join(root, 'src/app.css'));

    expect(result.ok, result.ok ? '' : result.error).toBe(true);
    if (!result.ok) return;
    expect(result.value.theme.get(['--color-acme-100'])).toBe('#abcdef');
  });

  it('names the unresolvable import in the failure instead of throwing', async () => {
    const root = useTailwindRepo({
      css: '@import "tailwindcss";\n@import "@acme/missing";\n',
    });

    const result = await loadDesignSystem(root, join(root, 'src/app.css'));

    expect(result.ok, result.ok ? '' : result.error).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('@acme/missing');
    expect(result.error).toContain('not installed');
  });
});

describe('loadFirstCompilingDesignSystem', () => {
  it('skips a candidate whose imported package ships no stylesheet, then loads the next', async () => {
    const root = useTailwindRepo();
    const first = writeCssFile(
      root,
      'first.css',
      '@import "tailwindcss";\n@import "starlight-theme/tailwind.css";\n',
    );
    addPackage(root, 'starlight-theme', {}, { 'index.css': '' });
    const second = writeCssFile(root, 'second.css', DEFAULT_ENTRY_CSS);

    const result = await loadFirstCompilingDesignSystem(root, [first, second]);

    expect(result.ok, result.ok ? '' : result.error).toBe(true);
    if (!result.ok) return;
    expect(result.value.system.entryCssPath).toBe(second);
    expect(result.value.skipped).toHaveLength(1);
    expect(result.value.skipped[0]?.path).toBe(first);
    expect(result.value.skipped[0]?.error).toContain(
      'no stylesheet was found there for "tailwind.css"',
    );
  });

  it('names every candidate and its own failure when none compile', async () => {
    const root = useTailwindRepo();
    const first = writeCssFile(
      root,
      'first.css',
      '@import "tailwindcss";\n@import "starlight-theme/tailwind.css";\n',
    );
    addPackage(root, 'starlight-theme', {}, { 'index.css': '' });
    const second = writeCssFile(
      root,
      'second.css',
      '@import "tailwindcss";\n@import "@acme/tokens/dark";\n',
    );
    addPackage(
      root,
      '@acme/tokens',
      { exports: { '.': './tokens.css', './dark': './tokens-dark.css' } },
      { 'tokens.css': '' },
    );

    const result = await loadFirstCompilingDesignSystem(root, [first, second]);

    expect(result.ok, result.ok ? '' : result.error).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain(first);
    expect(result.error).toContain(second);
    expect(result.error).toContain(
      'no stylesheet was found there for "tailwind.css"',
    );
    expect(result.error).toContain('no stylesheet was found there for "dark"');
  });

  it('reports no skipped candidates when the first one compiles', async () => {
    const root = useTailwindRepo();

    const result = await loadFirstCompilingDesignSystem(root, [
      join(root, 'src/app.css'),
    ]);

    expect(result.ok, result.ok ? '' : result.error).toBe(true);
    if (!result.ok) return;
    expect(result.value.skipped).toEqual([]);
  });

  it('fails when given no candidate paths', async () => {
    const root = useTailwindRepo();

    const result = await loadFirstCompilingDesignSystem(root, []);

    expect(result.ok, result.ok ? '' : result.error).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('No candidate');
  });

  it('reports the missing tailwindcss install once, before any candidate is tried', async () => {
    const root = useBareRepo();
    const first = join(root, 'a.css');
    const second = join(root, 'b.css');

    const result = await loadFirstCompilingDesignSystem(root, [first, second]);

    expect(result.ok, result.ok ? '' : result.error).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('tailwindcss');
    expect(result.error).not.toContain(first);
    expect(result.error).not.toContain(second);
  });
});

describe('isRepoDefinedThemeKey', () => {
  it('is true for a key the repo declared in its own @theme block', async () => {
    const root = useTailwindRepo();
    const result = await loadDesignSystem(root, join(root, 'src/app.css'));

    expect(result.ok, result.ok ? '' : result.error).toBe(true);
    if (!result.ok) return;
    expect(
      isRepoDefinedThemeKey(result.value.theme, '--color-brand-500'),
      '--color-brand-500 is repo-defined',
    ).toBe(true);
  });

  it("is false for a key that only exists in Tailwind's default palette", async () => {
    const root = useTailwindRepo();
    const result = await loadDesignSystem(root, join(root, 'src/app.css'));

    expect(result.ok, result.ok ? '' : result.error).toBe(true);
    if (!result.ok) return;
    expect(
      isRepoDefinedThemeKey(result.value.theme, '--color-red-500'),
      "--color-red-500 is Tailwind's default palette, not repo-defined",
    ).toBe(false);
  });
});

describe('findThemeEntryCss', () => {
  it('picks the file that imports tailwindcss out of a list that also holds a plain stylesheet', () => {
    const dir = tempCssDir();
    const plain = writeCssFile(dir, 'plain.css', '.a { color: red; }');
    const entry = writeCssFile(
      dir,
      'app.css',
      '@import "tailwindcss";\n@theme { --color-brand-500: oklch(0.55 0.2 265); }',
    );

    const result = findThemeEntryCss([plain, entry]);

    expect(result.ok, result.ok ? '' : result.error).toBe(true);
    if (!result.ok) return;
    expect(result.value.path).toBe(entry);
    expect(result.value.alternates).toEqual([]);
  });

  it('reports a second Tailwind-importing file as an alternate rather than an error', () => {
    const dir = tempCssDir();
    const first = writeCssFile(dir, 'a.css', '@import "tailwindcss";');
    const second = writeCssFile(dir, 'b.css', "@import 'tailwindcss';");

    const result = findThemeEntryCss([first, second]);

    expect(result.ok, result.ok ? '' : result.error).toBe(true);
    if (!result.ok) return;
    expect(result.value.path).toBe(first);
    expect(result.value.alternates).toEqual([second]);
  });

  it('names how many files it checked when none import tailwindcss', () => {
    const dir = tempCssDir();
    const plain = writeCssFile(dir, 'plain.css', '.a { color: red; }');

    const result = findThemeEntryCss([plain]);

    expect(result.ok, result.ok ? '' : result.error).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('1 file(s)');
  });

  it.skipIf(!CHMOD_ENFORCES_UNREADABLE)(
    'reports an unreadable entry file distinctly from a file that simply does not import tailwindcss',
    () => {
      const dir = tempCssDir();
      const entry = writeCssFile(dir, 'app.css', '@import "tailwindcss";');
      chmodSync(entry, 0o000);

      const result = findThemeEntryCss([entry]);

      expect(result.ok, result.ok ? '' : result.error).toBe(false);
      if (result.ok) return;
      expect(result.error).toContain('could not be read');
      expect(result.error).not.toContain('No CSS file imports');
    },
  );
});
