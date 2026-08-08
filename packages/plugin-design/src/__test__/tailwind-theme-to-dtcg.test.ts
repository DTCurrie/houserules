import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  loadDesignSystem,
  type TailwindTheme,
} from '../../payload/scripts/lib/tailwind-design-system.mts';
import { projectThemeToDtcg } from '../../payload/scripts/lib/tailwind-theme-to-dtcg.mts';
import { useTailwindRepo } from '#test/tailwind-fixture';

async function loadTheme(root: string): Promise<TailwindTheme> {
  const result = await loadDesignSystem(root, join(root, 'src/app.css'));
  if (!result.ok) throw new Error(result.error);
  return result.value.theme;
}

function group(
  document: Record<string, unknown>,
  name: string,
): Record<string, unknown> {
  return document[name] as Record<string, unknown>;
}

function token(
  groupNode: Record<string, unknown>,
  name: string,
): Record<string, unknown> {
  return groupNode[name] as Record<string, unknown>;
}

describe('projectThemeToDtcg', () => {
  it('tags a repo-declared color with repo origin and carries its oklch value', async () => {
    const theme = await loadTheme(useTailwindRepo());

    const { document } = projectThemeToDtcg(theme);

    expect(token(group(document, 'color'), 'brand-500')).toEqual({
      $value: { colorSpace: 'oklch', components: [0.55, 0.2, 265] },
      $description: "declared in the repo's @theme block",
      $extensions: { 'agent-kit': { origin: 'repo' } },
    });
  });

  it('tags a repo-declared font size with repo origin and a dimension value', async () => {
    const theme = await loadTheme(useTailwindRepo());

    const { document } = projectThemeToDtcg(theme);

    expect(token(group(document, 'fontSize'), 'hero')).toEqual({
      $value: { value: 3, unit: 'rem' },
      $description: "declared in the repo's @theme block",
      $extensions: { 'agent-kit': { origin: 'repo' } },
    });
  });

  it("tags one of Tailwind's own font weights with tailwind origin", async () => {
    const theme = await loadTheme(useTailwindRepo());

    const { document } = projectThemeToDtcg(theme);

    expect(token(group(document, 'fontWeight'), 'thin')).toEqual({
      $value: 100,
      $description: "declared in Tailwind's default theme",
      $extensions: { 'agent-kit': { origin: 'tailwind' } },
    });
  });

  it('keeps font-weight entries out of the fontFamily group', async () => {
    const theme = await loadTheme(useTailwindRepo());

    const { document } = projectThemeToDtcg(theme);

    expect(group(document, 'fontFamily')['weight-thin']).toBeUndefined();
  });

  it('drops a shadow namespace entry since its raw CSS string has no DTCG shape', async () => {
    const theme = await loadTheme(useTailwindRepo());

    const { dropped } = projectThemeToDtcg(theme);

    expect(dropped).toContain('0 1px rgb(0 0 0 / 0.05)');
  });

  it('counts the handful of repo-declared entries against a much larger tailwind count', async () => {
    const theme = await loadTheme(useTailwindRepo());

    const { counts } = projectThemeToDtcg(theme);

    expect(counts.repo).toBe(3);
    expect(counts.tailwind).toBeGreaterThan(50);
  });

  it('keeps a default-palette percentage-lightness oklch color, tagged tailwind origin', async () => {
    const theme = await loadTheme(useTailwindRepo());

    const { document } = projectThemeToDtcg(theme);

    expect(token(group(document, 'color'), 'red-500')).toEqual({
      $value: { colorSpace: 'oklch', components: [0.637, 0.237, 25.331] },
      $description: "declared in Tailwind's default theme",
      $extensions: { 'agent-kit': { origin: 'tailwind' } },
    });
  });
});

describe('projectThemeToDtcg, spacing multiplier projection', () => {
  it('projects the generated scale from a bare --spacing multiplier declared alone', async () => {
    const theme = await loadTheme(
      useTailwindRepo({
        css: `@import "tailwindcss";

@theme {
  --color-brand-500: oklch(0.55 0.2 265);
  --spacing: 0.5rem;
}
`,
      }),
    );

    const { document, counts } = projectThemeToDtcg(theme);
    const spacing = group(document, 'spacing');

    expect(token(spacing, '4')).toEqual({
      $value: { value: 2, unit: 'rem' },
      $description:
        "derived from the --spacing multiplier in the repo's @theme block",
      $extensions: { 'agent-kit': { origin: 'repo' } },
    });
    expect(Object.keys(spacing)).toHaveLength(35);
    expect(counts.repo).toBe(2);
  });

  it("projects only explicit --spacing-* keys as repo tokens when the multiplier is Tailwind's default", async () => {
    const theme = await loadTheme(
      useTailwindRepo({
        css: `@import "tailwindcss";

@theme {
  --color-brand-500: oklch(0.55 0.2 265);
  --spacing-lg: 2rem;
  --spacing-sm: 0.5rem;
}
`,
      }),
    );

    const { document, counts } = projectThemeToDtcg(theme);
    const spacing = group(document, 'spacing');

    expect(token(spacing, 'lg')).toEqual({
      $value: { value: 2, unit: 'rem' },
      $description: "declared in the repo's @theme block",
      $extensions: { 'agent-kit': { origin: 'repo' } },
    });
    expect(token(spacing, 'sm')).toEqual({
      $value: { value: 0.5, unit: 'rem' },
      $description: "declared in the repo's @theme block",
      $extensions: { 'agent-kit': { origin: 'repo' } },
    });
    expect(token(spacing, '2')).toEqual({
      $value: { value: 0.5, unit: 'rem' },
      $description:
        "derived from the --spacing multiplier in Tailwind's default theme",
      $extensions: { 'agent-kit': { origin: 'tailwind' } },
    });
    expect(counts.repo).toBe(3);
  });

  it('lets an explicit --spacing-* key win over a generated step of the same name', async () => {
    const theme = await loadTheme(
      useTailwindRepo({
        css: `@import "tailwindcss";

@theme {
  --color-brand-500: oklch(0.55 0.2 265);
  --spacing: 0.5rem;
  --spacing-2: 100rem;
}
`,
      }),
    );

    const { document, counts } = projectThemeToDtcg(theme);
    const spacing = group(document, 'spacing');

    expect(token(spacing, '2')).toEqual({
      $value: { value: 100, unit: 'rem' },
      $description: "declared in the repo's @theme block",
      $extensions: { 'agent-kit': { origin: 'repo' } },
    });
    expect(token(spacing, '4')).toEqual({
      $value: { value: 2, unit: 'rem' },
      $description:
        "derived from the --spacing multiplier in the repo's @theme block",
      $extensions: { 'agent-kit': { origin: 'repo' } },
    });
    expect(Object.keys(spacing)).toHaveLength(35);
    expect(counts.repo).toBe(3);
  });
});
