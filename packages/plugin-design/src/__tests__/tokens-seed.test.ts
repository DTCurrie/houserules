import { describe, expect, it } from 'vitest';

import { isUntouchedSeed, renderTokenSeed } from '../tokens-seed.js';

describe('renderTokenSeed', () => {
  it('parses as JSON', () => {
    expect(() => JSON.parse(renderTokenSeed())).not.toThrow();
  });

  it('writes colors as DTCG color objects, not hex or CSS strings', () => {
    const seed = JSON.parse(renderTokenSeed());

    const primary = seed.color.brand.primary.$value;

    expect(primary.colorSpace).toBe('srgb');
    expect(primary.components).toHaveLength(3);
    const outOfRange = primary.components.filter((c: number) => c < 0 || c > 1);
    expect(outOfRange, 'components out of the 0-1 range').toEqual([]);
  });

  it('writes dimensions as value/unit pairs, not CSS strings', () => {
    const seed = JSON.parse(renderTokenSeed());

    expect(seed.spacing.md.$value).toEqual({ value: 1, unit: 'rem' });
  });
});

describe('isUntouchedSeed', () => {
  it('is true for the exact rendered seed', () => {
    expect(isUntouchedSeed(renderTokenSeed())).toBe(true);
  });

  it('is true when only trailing whitespace differs', () => {
    expect(isUntouchedSeed(`${renderTokenSeed()}\n\n  `)).toBe(true);
  });

  it('is false once a value is edited', () => {
    const edited = renderTokenSeed().replace('0.231', '0.5');

    expect(isUntouchedSeed(edited)).toBe(false);
  });
});
