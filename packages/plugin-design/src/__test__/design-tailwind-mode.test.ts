import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { useBareRepo, useTailwindRepo } from '#test/tailwind-fixture';

const DESIGN_SCRIPT = fileURLToPath(
  new URL('../../payload-dist/scripts/design.mjs', import.meta.url),
);

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
    expect(result.stderr).not.toContain('agent-kit init');
  });
});
