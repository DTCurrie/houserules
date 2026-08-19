import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { useInstalledRepo } from '#test/repo';
import { runScript } from '#test/run';

const PLUGIN_DESIGN = fileURLToPath(new URL('../..', import.meta.url));
const PLUGINS = [{ name: PLUGIN_DESIGN, alias: 'design' }];

function installed(): string {
  return useInstalledRepo('pnpm-monorepo', {
    modules: 'design/design',
    plugins: PLUGINS,
  });
}

function extract(root: string) {
  return runScript(root, '.claude/scripts/design.mjs', { args: ['extract'] });
}

describe('design.mjs extract', () => {
  it('installs every lib the script imports, since a missing one fails at runtime with ERR_MODULE_NOT_FOUND', () => {
    const root = installed();

    expect(
      existsSync(join(root, '.claude/scripts/lib/dtcg-normalize.mjs')),
    ).toBe(true);
    expect(
      existsSync(join(root, '.claude/scripts/lib/tailwind-theme.mjs')),
    ).toBe(true);
    expect(
      existsSync(join(root, '.claude/scripts/lib/css-custom-properties.mjs')),
    ).toBe(true);
    expect(
      existsSync(join(root, '.claude/scripts/lib/style-literals.mjs')),
    ).toBe(true);
  });

  it('emits DTCG values from a @theme block on stdout', () => {
    const root = installed();
    writeFileSync(
      join(root, 'theme.css'),
      '@theme { --color-brand: #3b5bdb; --spacing-md: 1rem; }',
    );

    const result = extract(root);
    const document = JSON.parse(result.stdout) as Record<string, unknown>;

    expect(result.status).toBe(0);
    expect(document.color).toMatchObject({
      brand: {
        $value: { colorSpace: 'srgb', components: [0.231, 0.357, 0.859] },
      },
    });
    expect(document.spacing).toMatchObject({
      md: { $value: { value: 1, unit: 'rem' } },
    });
  });

  it('emits DTCG values from :root custom properties when no @theme block exists', () => {
    const root = installed();
    writeFileSync(join(root, 'globals.css'), ':root { --radius-card: 8px; }');

    const result = extract(root);
    const document = JSON.parse(result.stdout) as Record<string, unknown>;

    expect(result.status).toBe(0);
    expect(document.radius).toMatchObject({
      card: { $value: { value: 8, unit: 'px' } },
    });
  });

  it('prefers a @theme value over a conflicting :root value in the same group and name', () => {
    const root = installed();
    writeFileSync(
      join(root, 'theme.css'),
      '@theme { --spacing-md: 1rem; } :root { --md: 2rem; }',
    );

    const result = extract(root);
    const document = JSON.parse(result.stdout) as Record<string, unknown>;

    expect(document.spacing).toMatchObject({
      md: { $value: { value: 1, unit: 'rem' } },
    });
  });

  it('prints a DTCG document on stdout with no diagnostics mixed in, so stdout parses on its own', () => {
    const root = installed();
    writeFileSync(join(root, 'theme.css'), '@theme { --spacing-md: 1rem; }');

    const result = extract(root);

    expect(() => JSON.parse(result.stdout)).not.toThrow();
    expect(result.stderr.length).toBeGreaterThan(0);
  });

  it('puts the unsupported Tailwind v3 notice on stderr and still reads other sources', () => {
    const root = installed();
    writeFileSync(join(root, 'tailwind.config.ts'), 'export default {};\n');
    writeFileSync(join(root, 'globals.css'), ':root { --spacing-md: 1rem; }');

    const result = extract(root);
    const document = JSON.parse(result.stdout) as Record<string, unknown>;

    expect(result.stderr).toMatch(/Tailwind v3 config detected/);
    expect(document.spacing).toMatchObject({
      md: { $value: { value: 1, unit: 'rem' } },
    });
  });

  it('writes nothing, leaving the installed tokens.json byte-identical', () => {
    const root = installed();
    writeFileSync(join(root, 'theme.css'), '@theme { --spacing-md: 1rem; }');
    const tokensPath = join(root, '.claude/design/tokens.json');
    const before = readFileSync(tokensPath, 'utf8');

    extract(root);

    expect(readFileSync(tokensPath, 'utf8')).toBe(before);
  });
});
