/**
 * Milliseconds from `start` to `end`, both epoch milliseconds.
 *
 * @param {number} start
 * @param {number} end
 */
export function elapsed(start, end) {
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    throw new TypeError('elapsed needs two finite numbers');
  }
  if (end < start) throw new RangeError('end comes before start');
  return end - start;
}
