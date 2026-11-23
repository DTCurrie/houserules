/**
 * Check that a parsed range holds two numbers in order, and return it.
 *
 * @param {{ min: unknown, max: unknown }} range
 * @returns {{ min: number, max: number }}
 */
export function validateRange(range) {
  for (const key of ['min', 'max']) {
    const value = range[key];
    if (typeof value !== 'number' || Number.isNaN(value)) {
      throw new TypeError(`Range ${key} must be a number, got ${value}`);
    }
  }
  if (range.min > range.max) {
    throw new RangeError(`Range min ${range.min} is above max ${range.max}`);
  }
  return /** @type {{ min: number, max: number }} */ (range);
}
