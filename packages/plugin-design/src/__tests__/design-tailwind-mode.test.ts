import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  addPackage,
  DEFAULT_ENTRY_CSS,
  useBareRepo,
  useTailwindRepo,
} from '#test/tailwind-fixture';
import { DESIGN_SCRIPT } from '#test/staged-scripts';

function writeConfigJson(
  root: string,
  overrides: Record<string, unknown>,
): void {
  mkdirSync(join(root, '.claude'), { recursive: true });
  writeFileSync(
    join(root, '.claude/houserules.config.json'),
    JSON.stringify(
      { version: 2, packageManager: 'pnpm', targets: [], ...overrides },
      null,
      2,
    ),
  );
}

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

describe('design.mjs Tailwind mode', () => {
  it('resolves a repo-declared color token with no token file present', () => {
    const root = useTailwindRepo();

    const result = design(root, 'token', 'color.brand-500');

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('$type: color');
    expect(result.stdout).toContain('value: oklch(0.55, 0.2, 265)');
  });

  it('derives a spacing scale from a bare --spacing multiplier', () => {
    const root = useTailwindRepo();

    const result = design(root, 'scales');

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('spacing:');
    expect(result.stdout).toContain('spacing.4  1rem');
  });

  it('names the entry stylesheet on stderr as the answering source', () => {
    const root = useTailwindRepo();

    const result = design(root, 'token', 'color.brand-500');

    expect(result.stderr).toContain(join(root, 'src/app.css'));
  });

  it('exits non-zero naming the install command when tailwindcss is not installed', () => {
    const root = useBareRepo();
    const cssPath = join(root, 'src/app.css');
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(cssPath, '@import "tailwindcss";\n');

    const result = design(root, 'token', 'color.brand-500');

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('npm install -D tailwindcss@4');
    expect(result.stderr).not.toMatch(/at Object\.|at file:/);
  });

  it('answers from the token file named by --tokens, which outranks Tailwind resolution', () => {
    const root = useBareRepo();
    mkdirSync(join(root, '.claude/design'), { recursive: true });
    writeFileSync(
      join(root, '.claude/design/tokens.json'),
      JSON.stringify({
        spacing: {
          $type: 'dimension',
          md: { $value: { value: 1, unit: 'rem' } },
        },
      }),
    );

    const result = design(
      root,
      '--tokens',
      '.claude/design/tokens.json',
      'token',
      'spacing.md',
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('value: 1rem');
    expect(result.stderr).toContain(join(root, '.claude/design/tokens.json'));
  });

  it('names the missing @import rather than falling back when no stylesheet imports Tailwind', () => {
    const root = useBareRepo();
    mkdirSync(join(root, '.claude/design'), { recursive: true });
    writeFileSync(join(root, '.claude/design/tokens.json'), '{}');

    const result = design(root, 'token', 'spacing.md');

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('@import "tailwindcss"');
    expect(result.stderr).toContain('--theme <path>');
    expect(result.stderr).not.toContain('houserules init');
  });

  it('falls through a stylesheet that fails to compile and answers from a later one that does', () => {
    const root = useTailwindRepo({ cssPath: 'packages/ui/src/app.css' });
    mkdirSync(join(root, 'apps/docs/src'), { recursive: true });
    writeFileSync(
      join(root, 'apps/docs/src/tailwind.css'),
      '@import "tailwindcss";\n@import "starlight-theme/tailwind.css";\n',
    );
    addPackage(root, 'starlight-theme', {}, { 'index.css': '' });

    const result = design(root, 'token', 'color.brand-500');

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('value: oklch(0.55, 0.2, 265)');
    expect(result.stderr).toContain(join(root, 'apps/docs/src/tailwind.css'));
    expect(result.stderr).toContain(join(root, 'packages/ui/src/app.css'));
    expect(result.stderr).toContain(
      'no stylesheet was found there for "tailwind.css"',
    );
  });

  it('exits non-zero naming --theme when every candidate stylesheet fails to compile', () => {
    const root = useTailwindRepo({ cssPath: 'packages/ui/src/app.css' });
    mkdirSync(join(root, 'apps/docs/src'), { recursive: true });
    writeFileSync(
      join(root, 'apps/docs/src/tailwind.css'),
      '@import "tailwindcss";\n@import "starlight-theme/tailwind.css";\n',
    );
    addPackage(root, 'starlight-theme', {}, { 'index.css': '' });
    writeFileSync(
      join(root, 'packages/ui/src/app.css'),
      '@import "tailwindcss";\n@import "@acme/tokens/dark";\n',
    );
    addPackage(
      root,
      '@acme/tokens',
      { exports: { '.': './tokens.css', './dark': './tokens-dark.css' } },
      { 'tokens.css': '' },
    );

    const result = design(root, 'token', 'color.brand-500');

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(join(root, 'apps/docs/src/tailwind.css'));
    expect(result.stderr).toContain(join(root, 'packages/ui/src/app.css'));
    expect(result.stderr).toContain('for "dark"');
    expect(result.stderr).toContain('--theme');
  });

  it('does not fall back when --theme names a stylesheet that fails to compile', () => {
    const root = useTailwindRepo({ cssPath: 'packages/ui/src/app.css' });
    mkdirSync(join(root, 'apps/docs/src'), { recursive: true });
    writeFileSync(
      join(root, 'apps/docs/src/tailwind.css'),
      '@import "tailwindcss";\n@import "starlight-theme/tailwind.css";\n',
    );
    addPackage(root, 'starlight-theme', {}, { 'index.css': '' });

    const result = design(
      root,
      '--theme',
      'apps/docs/src/tailwind.css',
      'token',
      'color.brand-500',
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('could not be compiled');
    expect(result.stderr).not.toContain(join(root, 'packages/ui/src/app.css'));
  });

  it('answers from design.themeEntry in the config over the walk-order first', () => {
    const root = useTailwindRepo({ cssPath: 'apps/site/src/app.css' });
    mkdirSync(join(root, 'packages/ui/src'), { recursive: true });
    writeFileSync(
      join(root, 'packages/ui/src/app.css'),
      '@import "tailwindcss";\n\n@theme {\n  --color-brand-500: oklch(0.7 0.1 120);\n}\n',
    );
    writeConfigJson(root, {
      design: { themeEntry: 'packages/ui/src/app.css' },
    });

    const result = design(root, 'token', 'color.brand-500');

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('value: oklch(0.7, 0.1, 120)');
    expect(result.stderr).toContain('design.themeEntry');
  });

  it('exits non-zero naming design.themeEntry and the path when the configured entry does not exist', () => {
    const root = useTailwindRepo({ cssPath: 'apps/site/src/app.css' });
    writeConfigJson(root, {
      design: { themeEntry: 'packages/missing/app.css' },
    });

    const result = design(root, 'token', 'color.brand-500');

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('design.themeEntry');
    expect(result.stderr).toContain('packages/missing/app.css');
    expect(result.stderr).not.toContain('apps/site/src/app.css');
  });

  it('lets --theme outrank design.themeEntry in the config', () => {
    const root = useTailwindRepo({ cssPath: 'apps/site/src/app.css' });
    mkdirSync(join(root, 'packages/ui/src'), { recursive: true });
    writeFileSync(
      join(root, 'packages/ui/src/app.css'),
      '@import "tailwindcss";\n\n@theme {\n  --color-brand-500: oklch(0.7 0.1 120);\n}\n',
    );
    writeConfigJson(root, {
      design: { themeEntry: 'packages/ui/src/app.css' },
    });

    const result = design(
      root,
      '--theme',
      'apps/site/src/app.css',
      'token',
      'color.brand-500',
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('value: oklch(0.55, 0.2, 265)');
  });

  it('names every skipped stylesheet when several compile but one is chosen', () => {
    const root = useTailwindRepo({ cssPath: 'packages/ui/src/app.css' });
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src/other.css'), DEFAULT_ENTRY_CSS);

    const result = design(root, 'token', 'color.brand-500');

    expect(result.status).toBe(0);
    expect(result.stderr).toContain(
      'ignoring 1 other file(s) that also import Tailwind',
    );
  });
});
