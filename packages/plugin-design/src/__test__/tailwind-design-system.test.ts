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
} from '../../payload/scripts/lib/tailwind-design-system.mts';
import { useBareRepo, useTailwindRepo } from '#test/tailwind-fixture';

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

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.theme.size).toBeGreaterThan(400);
  });

  it('reads the repo-declared brand color out of the theme', async () => {
    const root = useTailwindRepo();

    const result = await loadDesignSystem(root, join(root, 'src/app.css'));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.theme.get(['--color-brand-500'])).toBe(
      'oklch(0.55 0.2 265)',
    );
  });

  it('compiles a spacing utility to a calc() expression against the repo spacing scale', async () => {
    const root = useTailwindRepo();

    const result = await loadDesignSystem(root, join(root, 'src/app.css'));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [css] = result.value.candidatesToCss(['p-3']);
    expect(css).toContain('calc(var(--spacing) * 3)');
  });

  it('resolves an unrecognized candidate to null', async () => {
    const root = useTailwindRepo();

    const result = await loadDesignSystem(root, join(root, 'src/app.css'));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.candidatesToCss(['not-a-real-class'])).toEqual([null]);
  });

  it('fails with the install command and no stack trace when tailwindcss is not installed', async () => {
    const root = useBareRepo();
    writeFileSync(join(root, 'app.css'), '@import "tailwindcss";');

    const result = await loadDesignSystem(root, join(root, 'app.css'));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe(
      `tailwindcss is not installed in ${root}. Install it in that repo with \`npm install -D tailwindcss@4\`.`,
    );
  });
});

describe('isRepoDefinedThemeKey', () => {
  it('is true for a key the repo declared in its own @theme block', async () => {
    const root = useTailwindRepo();
    const result = await loadDesignSystem(root, join(root, 'src/app.css'));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(isRepoDefinedThemeKey(result.value.theme, '--color-brand-500')).toBe(
      true,
    );
  });

  it("is false for a key that only exists in Tailwind's default palette", async () => {
    const root = useTailwindRepo();
    const result = await loadDesignSystem(root, join(root, 'src/app.css'));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(isRepoDefinedThemeKey(result.value.theme, '--color-red-500')).toBe(
      false,
    );
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

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.path).toBe(entry);
    expect(result.value.alternates).toEqual([]);
  });

  it('reports a second Tailwind-importing file as an alternate rather than an error', () => {
    const dir = tempCssDir();
    const first = writeCssFile(dir, 'a.css', '@import "tailwindcss";');
    const second = writeCssFile(dir, 'b.css', "@import 'tailwindcss';");

    const result = findThemeEntryCss([first, second]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.path).toBe(first);
    expect(result.value.alternates).toEqual([second]);
  });

  it('names how many files it checked when none import tailwindcss', () => {
    const dir = tempCssDir();
    const plain = writeCssFile(dir, 'plain.css', '.a { color: red; }');

    const result = findThemeEntryCss([plain]);

    expect(result.ok).toBe(false);
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

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toContain('could not be read');
      expect(result.error).not.toContain('No CSS file imports');
    },
  );
});
