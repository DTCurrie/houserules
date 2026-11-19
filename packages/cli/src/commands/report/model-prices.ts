import type { UsageSlice } from './transcript-events.js';

/** Dollars per million tokens. */
export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
}

const CACHE_WRITE_5M_MULTIPLE = 1.25;
const CACHE_WRITE_1H_MULTIPLE = 2;

const TOKENS_PER_MILLION = 1_000_000;

// Read on 2026-11-18 from the bundled claude-api models table, through the PRICES table in
// .claude/plans/health-2026-11-18/baseline/cost-map.mjs. Cache reads use the multiple the
// table states per model (0.025x Fable, 0.05x Opus 5.5 and Sonnet 5.5) and its general 0.1x
// elsewhere. Haiku's long-prompt tier (over 100k prompt tokens) is not modeled, since a
// per-model slice cannot see a single request's prompt size. Refresh when prices change.
const MODEL_PRICES: Record<string, ModelPrice> = {
  'claude-fable-5-2': { input: 8, output: 40, cacheRead: 0.2 },
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.1 },
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01 },
};

// A table id matches itself, or itself followed by a snapshot date (`-20261001`, `@20261001`)
// or a context-window tag (`[1m]`). Any other suffix is a different model: `claude-opus-5-6`
// must not fall back to the `claude-opus-5` row.
const MODEL_SUFFIX = /^(?:[-@]\d{8}|\[[^\]]*\])?$/;

/** The price row for a model id, or `undefined` when the table has none. */
export function lookupModelPrice(modelId: string): ModelPrice | undefined {
  for (const [tableId, price] of Object.entries(MODEL_PRICES)) {
    if (
      modelId.startsWith(tableId) &&
      MODEL_SUFFIX.test(modelId.slice(tableId.length))
    ) {
      return price;
    }
  }
  return undefined;
}

export interface UnpricedModel {
  model: string;
  /** Fraction of the report's weighted input, 0 to 1. */
  weightedShare: number;
}

export interface ListPrice {
  fresh: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  total: number;
  unpriced: UnpricedModel[];
}

/**
 * List-price dollars over per-model slices, split by what was billed. Cache writes bill at
 * 2x input for the 1-hour part and 1.25x for the rest. A model with no table row adds no
 * dollars and is named in `unpriced` with its share of weighted input.
 *
 * @param weigh The cost-weighted input of a slice, used only for the unpriced shares.
 */
export function computeListPrice(
  slices: Iterable<[string, UsageSlice]>,
  weigh: (slice: UsageSlice) => number,
): ListPrice {
  const result: ListPrice = {
    fresh: 0,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0,
    total: 0,
    unpriced: [],
  };
  const unpricedWeight = new Map<string, number>();
  let totalWeight = 0;
  for (const [model, slice] of slices) {
    const weight = weigh(slice);
    totalWeight += weight;
    const price = lookupModelPrice(model);
    if (!price) {
      unpricedWeight.set(model, (unpricedWeight.get(model) ?? 0) + weight);
      continue;
    }
    const write1h = slice.cacheWrite1h ?? 0;
    const write5m = slice.cacheWrite - write1h;
    result.fresh += (slice.input * price.input) / TOKENS_PER_MILLION;
    result.cacheRead +=
      (slice.cacheRead * price.cacheRead) / TOKENS_PER_MILLION;
    result.cacheWrite +=
      (price.input *
        (write5m * CACHE_WRITE_5M_MULTIPLE +
          write1h * CACHE_WRITE_1H_MULTIPLE)) /
      TOKENS_PER_MILLION;
    result.output += (slice.output * price.output) / TOKENS_PER_MILLION;
  }
  result.total =
    result.fresh + result.cacheRead + result.cacheWrite + result.output;
  result.unpriced = [...unpricedWeight].map(([model, weight]) => ({
    model,
    weightedShare: totalWeight ? weight / totalWeight : 0,
  }));
  return result;
}
