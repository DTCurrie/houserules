import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { useInstalledRepo } from '#test/repo';
import { useTailwindRepo } from '#test/tailwind-fixture';

import { loadDesignSystem } from '../tailwind-design-system.mts';

const PLUGIN_DESIGN = fileURLToPath(new URL('../../../..', import.meta.url));
const PLUGINS = [{ name: PLUGIN_DESIGN, alias: 'design' }];

const TEMPLATE_PATH = '.claude/templates/tailwind-theme.css.template';
const REFERENCE_PATH = '.claude/reference/design-tailwind-theming.md';

function installed(): string {
  return useInstalledRepo('pnpm-monorepo', {
    modules: 'design/design,design/design-tailwind',
    plugins: PLUGINS,
  });
}

describe('design-tailwind theming install', () => {
  it('installs the template and reference at the expected paths', () => {
    const root = installed();

    expect(existsSync(join(root, TEMPLATE_PATH))).toBe(true);
    expect(existsSync(join(root, REFERENCE_PATH))).toBe(true);
  });

  it("names the reference in the design rule's routing table", () => {
    const root = installed();

    const ruleText = readFileSync(
      join(root, '.claude/rules/design.md'),
      'utf8',
    );

    expect(ruleText).toContain('design-tailwind-theming.md');
  });

  it('does not claim @theme must be top-level', () => {
    const root = installed();

    const content = readFileSync(join(root, REFERENCE_PATH), 'utf8');

    expect(content).not.toMatch(/@theme.*must be top-level/i);
    expect(content).not.toMatch(/top-level.*@theme.*must/i);
  });
});

describe('tailwind-theme.css.template', () => {
  it('compiles under real Tailwind with no error', async () => {
    const templatePath = join(
      PLUGIN_DESIGN,
      'payload/templates/tailwind-theme.css.template',
    );
    const templateContent = readFileSync(templatePath, 'utf8');
    const root = useTailwindRepo({ css: templateContent });

    const result = await loadDesignSystem(root, join(root, 'src/app.css'));

    expect(result.ok).toBe(true);
  });

  it('resolves a utility from its semantic layer', async () => {
    const templatePath = join(
      PLUGIN_DESIGN,
      'payload/templates/tailwind-theme.css.template',
    );
    const templateContent = readFileSync(templatePath, 'utf8');
    const root = useTailwindRepo({ css: templateContent });

    const result = await loadDesignSystem(root, join(root, 'src/app.css'));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [css] = result.value.candidatesToCss(['bg-surface']);
    expect(css).toContain('background-color: var(--surface)');
  });

  it('closes off the default palette while keeping the semantic layer', async () => {
    const templatePath = join(
      PLUGIN_DESIGN,
      'payload/templates/tailwind-theme.css.template',
    );
    const templateContent = readFileSync(templatePath, 'utf8');
    const root = useTailwindRepo({ css: templateContent });

    const result = await loadDesignSystem(root, join(root, 'src/app.css'));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.candidatesToCss(['bg-red-500'])).toEqual([null]);
    expect(result.value.candidatesToCss(['bg-brand-500'])[0]).toContain(
      'background-color: var(--color-brand-500)',
    );
  });
});

describe('multi-theme example from the reference doc', () => {
  it('resolves the aliased utility to the underlying variable, not the indirection variable', async () => {
    const css = `@import "tailwindcss";
:root { --brand-accent: oklch(0.5 0.1 200); }
@theme { --color-accent: var(--brand-accent); }
[data-theme="midnight"] { --brand-accent: oklch(0.2 0.05 260); }
`;
    const root = useTailwindRepo({ css });

    const result = await loadDesignSystem(root, join(root, 'src/app.css'));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [plain] = result.value.candidatesToCss(['bg-accent']);
    expect(plain).toContain('background-color: var(--color-accent)');
  });

  it('with @theme inline, resolves straight to the underlying variable and emits no indirection variable', async () => {
    const css = `@import "tailwindcss";
:root { --brand-accent: oklch(0.5 0.1 200); }
@theme inline { --color-accent: var(--brand-accent); }
[data-theme="midnight"] { --brand-accent: oklch(0.2 0.05 260); }
`;
    const root = useTailwindRepo({ css });

    const result = await loadDesignSystem(root, join(root, 'src/app.css'));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [inline] = result.value.candidatesToCss(['bg-accent']);
    expect(inline).toContain('background-color: var(--brand-accent)');
    expect(inline).not.toContain('--color-accent');
  });
});
