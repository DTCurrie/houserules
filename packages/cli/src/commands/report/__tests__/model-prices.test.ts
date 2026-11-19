import { describe, expect, it } from 'vitest';

import { computeListPrice, lookupModelPrice } from '../model-prices.js';
import { emptyUsageSlice, type UsageSlice } from '../transcript-events.js';

function slice(counts: Partial<UsageSlice>): UsageSlice {
  return { ...emptyUsageSlice(), ...counts };
}

describe('lookupModelPrice', () => {
  it.each([
    { id: 'claude-opus-5-5', price: { input: 4, output: 20, cacheRead: 0.2 } },
    { id: 'claude-opus-5', price: { input: 5, output: 25, cacheRead: 0.5 } },
    {
      id: 'claude-opus-5-5-20261001',
      price: { input: 4, output: 20, cacheRead: 0.2 },
    },
    {
      id: 'claude-sonnet-5-5@20261001',
      price: { input: 2, output: 10, cacheRead: 0.1 },
    },
    {
      id: 'claude-fable-5-2[1m]',
      price: { input: 8, output: 40, cacheRead: 0.2 },
    },
  ])('matches $id to its own row', ({ id, price }) => {
    expect(lookupModelPrice(id)).toEqual(price);
  });

  it.each(['claude-opus-5-6', 'claude-opus-5-5-preview', 'claude-3-opus', ''])(
    'returns undefined for %j rather than a neighboring row',
    (id) => {
      expect(lookupModelPrice(id)).toBeUndefined();
    },
  );
});

describe('computeListPrice', () => {
  const opus = slice({
    input: 1_000_000,
    cacheRead: 10_000_000,
    cacheWrite: 2_000_000,
    cacheWrite1h: 500_000,
    output: 100_000,
  });
  const sonnetWithoutSplit = slice({
    input: 2_000_000,
    cacheWrite: 1_000_000,
    output: 500_000,
  });
  const mystery = slice({ input: 1_000_000 });
  const weighByInput = (s: UsageSlice) => s.input;

  it('splits dollars into fresh, cache read, cache write, and output across two models', () => {
    const result = computeListPrice(
      [
        ['claude-opus-5-5', opus],
        ['claude-sonnet-5-5', sonnetWithoutSplit],
      ],
      weighByInput,
    );

    expect(result.fresh).toBeCloseTo(8, 6);
    expect(result.cacheRead).toBeCloseTo(2, 6);
    expect(result.cacheWrite).toBeCloseTo(14, 6);
    expect(result.output).toBeCloseTo(7, 6);
    expect(result.total).toBeCloseTo(31, 6);
    expect(result.unpriced).toEqual([]);
  });

  it('names an unpriced model with its share of weighted input and adds no dollars for it', () => {
    const result = computeListPrice(
      [
        ['claude-opus-5-5', opus],
        ['claude-sonnet-5-5', sonnetWithoutSplit],
        ['mystery-model', mystery],
      ],
      weighByInput,
    );

    expect(result.total).toBeCloseTo(31, 6);
    expect(result.unpriced).toEqual([
      { model: 'mystery-model', weightedShare: 0.25 },
    ]);
  });
});
