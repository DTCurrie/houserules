/** @typedef {import('./validate.js').Range} Range */

/**
 * Whether a value lies inside a range, each bound included unless the range excludes it.
 *
 * @param {Range} range
 * @param {number} value
 */
export function contains(range, value) {
  const aboveMin = range.minExclusive ? value > range.min : value >= range.min;
  const belowMax = range.maxExclusive ? value < range.max : value <= range.max;
  return aboveMin && belowMax;
}

/**
 * The distance from a range's min to its max.
 *
 * @param {Range} range
 */
export function width(range) {
  return range.max - range.min;
}

/**
 * Bound a value to a range. A value inside the range comes back unchanged. A value outside
 * it comes back as the nearest bound, which needs that bound included. With `step`, a value
 * outside the range comes back as the nearest multiple of `step` inside it instead, which
 * works for an excluded bound too.
 *
 * @param {Range} range
 * @param {number} value
 * @param {number | undefined} step
 */
export function clampTo(range, value, step) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new TypeError(`Clamp value must be a number, got ${String(value)}`);
  }
  if (contains(range, value)) return value;
  const below = value < range.min;
  if (step === undefined) {
    if (below ? range.minExclusive : range.maxExclusive) {
      throw new RangeError('Clamping to an excluded bound needs a step');
    }
    return below ? range.min : range.max;
  }
  const lowest = lowestStep(range, step);
  const highest = highestStep(range, step);
  if (lowest > highest) {
    throw new RangeError(`No multiple of ${step} lies inside the range`);
  }
  return below ? lowest : highest;
}

/**
 * @param {Range} range
 * @param {number} step
 */
function lowestStep(range, step) {
  if (range.min === -Infinity) return -Infinity;
  let count = Math.ceil(range.min / step);
  if (range.minExclusive && count * step === range.min) count += 1;
  return count * step;
}

/**
 * @param {Range} range
 * @param {number} step
 */
function highestStep(range, step) {
  if (range.max === Infinity) return Infinity;
  let count = Math.floor(range.max / step);
  if (range.maxExclusive && count * step === range.max) count -= 1;
  return count * step;
}
