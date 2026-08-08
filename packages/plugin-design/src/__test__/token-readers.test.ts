import { describe, expect, it } from 'vitest';

import {
  normalizeToDtcg,
  parseColor,
  parseDimension,
  toMeasurableSrgb,
} from '../../payload/scripts/lib/dtcg-normalize.mts';
import {
  extractTailwindThemeCandidates,
  hasTailwindV3Config,
} from '../../payload/scripts/lib/tailwind-theme.mts';
import { extractCssCustomProperties } from '../../payload/scripts/lib/css-custom-properties.mts';
import { collectStyleTokenCandidates } from '../../payload/scripts/lib/style-literals.mts';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { onTestFinished } from 'vitest';

describe('parseColor', () => {
  it('expands a 3-digit hex to its 6-digit srgb components', () => {
    const color = parseColor('#f00');

    expect(color).toEqual({ colorSpace: 'srgb', components: [1, 0, 0] });
  });

  it('reads a 6-digit hex as srgb components', () => {
    const color = parseColor('#3b5bdb');

    expect(color).toEqual({
      colorSpace: 'srgb',
      components: [0.231, 0.357, 0.859],
    });
  });

  it('reads an 8-digit hex as srgb components plus alpha', () => {
    const color = parseColor('#3b5bdb80');

    expect(color).toEqual({
      colorSpace: 'srgb',
      components: [0.231, 0.357, 0.859],
      alpha: 0.502,
    });
  });

  it('reads an rgb() function as srgb components', () => {
    const color = parseColor('rgb(59, 91, 219)');

    expect(color).toEqual({
      colorSpace: 'srgb',
      components: [0.231, 0.357, 0.859],
    });
  });

  it('keeps an oklch() value in the oklch color space rather than converting it', () => {
    const color = parseColor('oklch(0.7 0.1 250)');

    expect(color).toEqual({ colorSpace: 'oklch', components: [0.7, 0.1, 250] });
  });

  it('reads a percentage lightness as a decimal', () => {
    const color = parseColor('oklch(63.7% 0.237 25.331)');

    expect(color).toEqual({
      colorSpace: 'oklch',
      components: [0.637, 0.237, 25.331],
    });
  });

  it('reads a percentage lightness with a percentage alpha', () => {
    const color = parseColor('oklch(63.7% 0.237 25.331 / 50%)');

    expect(color).toEqual({
      colorSpace: 'oklch',
      components: [0.637, 0.237, 25.331],
      alpha: 0.5,
    });
  });

  it('produces the same components for a decimal and a percentage lightness of the same color', () => {
    const decimal = parseColor('oklch(0.637 0.237 25.331)');
    const percentage = parseColor('oklch(63.7% 0.237 25.331)');

    expect(percentage).toEqual(decimal);
  });
});

describe('toMeasurableSrgb', () => {
  it('returns an srgb color unchanged', () => {
    const color = parseColor('#3b5bdb')!;

    expect(toMeasurableSrgb(color)).toEqual(color);
  });

  it('converts a decimal-lightness oklch color to the sRGB a browser renders for it', () => {
    const color = parseColor('oklch(0.55 0.2 265)')!;

    const measurable = toMeasurableSrgb(color)!;

    expect(measurable.colorSpace).toBe('srgb');
    expect(measurable.components[0]).toBeCloseTo(54 / 255, 2);
    expect(measurable.components[1]).toBeCloseTo(101 / 255, 2);
    expect(measurable.components[2]).toBeCloseTo(228 / 255, 2);
  });

  it('converts a percentage-lightness oklch color to the same sRGB as its decimal form', () => {
    const color = parseColor('oklch(63.7% 0.237 25.331)')!;

    const measurable = toMeasurableSrgb(color)!;

    expect(measurable.colorSpace).toBe('srgb');
    expect(measurable.components[0]).toBeCloseTo(251 / 255, 2);
    expect(measurable.components[1]).toBeCloseTo(44 / 255, 2);
    expect(measurable.components[2]).toBeCloseTo(54 / 255, 2);
  });

  it('returns undefined for a color space it has no conversion for', () => {
    expect(
      toMeasurableSrgb({
        colorSpace: 'display-p3',
        components: [0.5, 0.2, 0.3],
      }),
    ).toBeUndefined();
  });
});

describe('parseDimension', () => {
  it('parses a px value', () => {
    expect(parseDimension('8px')).toEqual({ value: 8, unit: 'px' });
  });

  it('parses a rem value', () => {
    expect(parseDimension('1.5rem')).toEqual({ value: 1.5, unit: 'rem' });
  });

  it('rejects a percentage', () => {
    expect(parseDimension('50%')).toBeUndefined();
  });

  it('rejects an em value', () => {
    expect(parseDimension('2em')).toBeUndefined();
  });
});

describe('normalizeToDtcg', () => {
  it('emits $type on the group node from the group', () => {
    const { document } = normalizeToDtcg([
      {
        group: 'spacing',
        name: 'md',
        raw: '1rem',
        occurrences: 2,
        source: 'test',
      },
    ]);

    expect((document.spacing as Record<string, unknown>).$type).toBe(
      'dimension',
    );
  });

  it('reports a value the group parser cannot represent in dropped', () => {
    const { dropped } = normalizeToDtcg([
      {
        group: 'spacing',
        name: 'md',
        raw: '50%',
        occurrences: 2,
        source: 'test',
      },
    ]);

    expect(dropped).toEqual(['50%']);
  });
});

describe('extractTailwindThemeCandidates', () => {
  it('classifies --font-weight-bold as fontWeight, not fontFamily', () => {
    const candidates = extractTailwindThemeCandidates(
      '@theme { --font-weight-bold: 700; }',
    );

    expect(candidates).toEqual([
      {
        group: 'fontWeight',
        name: 'bold',
        raw: '700',
        occurrences: 1,
        source: 'tailwind @theme',
      },
    ]);
  });

  it('reads declarations from two separate @theme blocks', () => {
    const candidates = extractTailwindThemeCandidates(
      '@theme { --color-brand: #3b5bdb; } @theme { --spacing-md: 1rem; }',
    );

    expect(candidates.map((candidate) => candidate.name).sort()).toEqual([
      'brand',
      'md',
    ]);
  });

  it('skips a commented-out declaration', () => {
    const candidates = extractTailwindThemeCandidates(
      '@theme { /* --color-brand: #3b5bdb; */ --spacing-md: 1rem; }',
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0].name).toBe('md');
  });

  it('reads a @theme default block', () => {
    const candidates = extractTailwindThemeCandidates(
      '@theme default { --spacing-md: 1rem; }',
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0].name).toBe('md');
  });

  it('reads a @theme static block', () => {
    const candidates = extractTailwindThemeCandidates(
      '@theme static { --spacing-md: 1rem; }',
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0].name).toBe('md');
  });

  it('reads a @theme block with two modifiers together', () => {
    const candidates = extractTailwindThemeCandidates(
      '@theme default static { --spacing-md: 1rem; }',
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0].name).toBe('md');
  });
});

describe('hasTailwindV3Config', () => {
  it('reports true for a tailwind.config.ts path', () => {
    expect(hasTailwindV3Config(['/repo/tailwind.config.ts'])).toBe(true);
  });
});

describe('extractCssCustomProperties', () => {
  it('reads a declaration inside :root', () => {
    const candidates = extractCssCustomProperties(
      ':root { --space-md: 1rem; }',
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ group: 'spacing', name: 'md' });
  });

  it('skips the same declaration when it is inside .card instead of :root', () => {
    const candidates = extractCssCustomProperties(
      '.card { --space-md: 1rem; }',
    );

    expect(candidates).toEqual([]);
  });

  it('skips a var() reference', () => {
    const candidates = extractCssCustomProperties(
      ':root { --space-md: var(--other); }',
    );

    expect(candidates).toEqual([]);
  });

  it('classifies --radius-card as radius', () => {
    const candidates = extractCssCustomProperties(
      ':root { --radius-card: 8px; }',
    );

    expect(candidates).toEqual([
      {
        group: 'radius',
        name: 'card',
        raw: '8px',
        occurrences: 1,
        source: 'css custom property',
      },
    ]);
  });

  it('classifies --space-md as spacing', () => {
    const candidates = extractCssCustomProperties(
      ':root { --space-md: 1rem; }',
    );

    expect(candidates).toEqual([
      {
        group: 'spacing',
        name: 'md',
        raw: '1rem',
        occurrences: 1,
        source: 'css custom property',
      },
    ]);
  });

  it('strips a group prefix so a :root property and a @theme property yield the same key', () => {
    const fromRoot = extractCssCustomProperties(
      ':root { --color-brand: #111; }',
    );
    const fromTheme = extractTailwindThemeCandidates(
      '@theme { --color-brand: #222; }',
    );

    expect(fromRoot[0].name).toBe(fromTheme[0].name);
  });
});

function styleFile(cssText: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'token-readers-'));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'styles.css');
  writeFileSync(path, cssText);
  return path;
}

describe('collectStyleTokenCandidates', () => {
  it('drops a value that appears only once', () => {
    const path = styleFile('.a { padding: 8px; }');

    const { candidates } = collectStyleTokenCandidates([path]);

    expect(candidates).toEqual([]);
  });

  it('keeps a value that appears twice', () => {
    const path = styleFile('.a { padding: 8px; } .b { padding: 8px; }');

    const { candidates } = collectStyleTokenCandidates([path]);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      group: 'spacing',
      raw: '8px',
      occurrences: 2,
    });
  });

  it('counts #FFF and #fff as the same value', () => {
    const path = styleFile('.a { color: #FFF; } .b { color: #fff; }');

    const { candidates } = collectStyleTokenCandidates([path]);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ group: 'color', occurrences: 2 });
  });

  it('classifies border-radius as radius', () => {
    const path = styleFile(
      '.a { border-radius: 8px; } .b { border-radius: 8px; }',
    );

    const { candidates } = collectStyleTokenCandidates([path]);

    expect(candidates[0]).toMatchObject({ group: 'radius', raw: '8px' });
  });

  it('classifies padding as spacing', () => {
    const path = styleFile('.a { padding: 8px; } .b { padding: 8px; }');

    const { candidates } = collectStyleTokenCandidates([path]);

    expect(candidates[0]).toMatchObject({ group: 'spacing', raw: '8px' });
  });

  it('reflects both the floor and the cap in droppedCount', () => {
    const declarations = [
      '.once { padding: 1px; }',
      ...Array.from(
        { length: 17 },
        (_, index) =>
          `.kept${index} { margin: ${index + 2}px; margin: ${index + 2}px; }`,
      ),
    ].join(' ');
    const path = styleFile(declarations);

    const { candidates, droppedCount } = collectStyleTokenCandidates([path]);

    expect(candidates).toHaveLength(16);
    expect(droppedCount).toBe(2);
  });
});
