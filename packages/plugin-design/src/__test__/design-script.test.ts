import { describe, expect, it } from 'vitest';
import { rmSync, writeFileSync } from 'node:fs';
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

function design(root: string, ...args: string[]) {
  return runScript(root, '.claude/scripts/design.mjs', { args });
}

describe('design.mjs', () => {
  it('resolves a color token to its type, value, and hex', () => {
    const root = installed();

    const result = design(root, 'token', 'color.brand.primary');

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('$type: color');
    expect(result.stdout).toContain('srgb(0.231, 0.357, 0.859)');
    expect(result.stdout).toContain('hex: #3b5bdb');
  });

  it('resolves a dimension token to its rendered value', () => {
    const root = installed();

    const result = design(root, 'token', 'spacing.md');

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('value: 1rem');
  });

  it('resolves a numeric-leading key', () => {
    const root = installed();

    const result = design(root, 'token', 'spacing.2xl');

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('value: 3rem');
  });

  it('lists only the tokens in the requested group', () => {
    const root = installed();

    const result = design(root, 'list', 'color');

    expect(result.status).toBe(0);
    const lines = result.stdout.trim().split('\n');
    expect(lines).toContain('color.brand.primary');
    expect(lines.every((line) => line.startsWith('color.'))).toBe(true);
  });

  it('prints the spacing, fontSize, and radius scales', () => {
    const root = installed();

    const result = design(root, 'scales');

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('spacing:');
    expect(result.stdout).toContain('fontSize:');
    expect(result.stdout).toContain('radius:');
    expect(result.stdout).toContain('spacing.xs  0.25rem');
  });

  it('exits non-zero with a message for an unknown token', () => {
    const root = installed();

    const result = design(root, 'token', 'color.nope');

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/no token/i);
  });

  it('exits non-zero without a stack trace for invalid JSON', () => {
    const root = installed();
    writeFileSync(join(root, '.claude/design/tokens.json'), '{ not json');

    const result = design(root, 'token', 'color.brand.primary');

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/not valid JSON/i);
    expect(result.stderr).not.toMatch(/\n\s+at /);
  });

  it('exits non-zero with a clear message when the token file is absent', () => {
    const root = installed();
    rmSync(join(root, '.claude/design/tokens.json'));

    const result = design(root, 'token', 'color.brand.primary');

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/no design tokens/i);
  });
});
