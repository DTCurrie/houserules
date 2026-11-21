const P95_QUANTILE = 0.95;

/** The noise gate: a case whose relMad exceeds `threshold` fails once it has `minSamples` runs. */
export const GATE = Object.freeze({
  statistic: 'relMad',
  threshold: 0.05,
  minSamples: 10,
});

/** Median of an already sorted array. */
function medianSorted(sorted) {
  const n = sorted.length;
  const mid = Math.floor(n / 2);
  return n % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Summarize timing samples in milliseconds, unrounded. Does not mutate the input.
 * @param {number[]} samplesMs
 * @returns {{ n: number, median: number, p95: number, mad: number, relMad: number, min: number, max: number }}
 * @throws {Error} on an empty array
 */
export function summarize(samplesMs) {
  if (!Array.isArray(samplesMs) || samplesMs.length === 0) {
    throw new Error('summarize needs at least one sample');
  }
  const sorted = [...samplesMs].sort((a, b) => a - b);
  const sampleCount = sorted.length;
  const median = medianSorted(sorted);
  const deviations = sorted
    .map((s) => Math.abs(s - median))
    .sort((a, b) => a - b);
  const mad = medianSorted(deviations);
  return {
    n: sampleCount,
    median,
    p95: sorted[Math.ceil(P95_QUANTILE * sampleCount) - 1],
    mad,
    relMad: median === 0 ? 0 : mad / median,
    min: sorted[0],
    max: sorted[sampleCount - 1],
  };
}

/**
 * Gate verdict for a summary. `insufficient` never fails.
 * @param {{ n: number, relMad: number }} stats
 * @param {{ threshold: number, minSamples: number }} [gate]
 * @returns {'pass' | 'fail' | 'insufficient'}
 */
export function gateVerdict(stats, gate = GATE) {
  if (stats.n < gate.minSamples) return 'insufficient';
  if (stats.relMad > gate.threshold) return 'fail';
  return 'pass';
}
