/**
 * @typedef {{ min: number, max: number, minExclusive: boolean, maxExclusive: boolean }} Range
 */

/**
 * Check that a parsed range holds two numbers in order with boolean exclusion flags, and that
 * it holds at least one value, and return it. `-Infinity` is a valid min and `Infinity` a
 * valid max.
 *
 * @param {{ min: unknown, max: unknown, minExclusive: unknown, maxExclusive: unknown }} range
 * @returns {Range}
 */
export function validateRange(range) {
  for (const key of ['min', 'max']) {
    const value = range[key];
    if (typeof value !== 'number' || Number.isNaN(value)) {
      throw new TypeError(`Range ${key} must be a number, got ${value}`);
    }
  }
  for (const key of ['minExclusive', 'maxExclusive']) {
    if (typeof range[key] !== 'boolean') {
      throw new TypeError(`Range ${key} must be a boolean, got ${range[key]}`);
    }
  }
  if (range.min === Infinity || range.max === -Infinity) {
    throw new RangeError(`Range ${range.min} to ${range.max} holds no value`);
  }
  if (range.min > range.max) {
    throw new RangeError(`Range min ${range.min} is above max ${range.max}`);
  }
  if (range.min === range.max && (range.minExclusive || range.maxExclusive)) {
    throw new RangeError(`Range ${range.min} to ${range.max} holds no value`);
  }
  return /** @type {Range} */ (range);
}

/**
 * Check a clamp step: a positive finite number, or undefined for no step.
 *
 * @param {unknown} step
 * @returns {number | undefined}
 */
export function validateStep(step) {
  if (step === undefined) return undefined;
  if (typeof step !== 'number' || !Number.isFinite(step) || step <= 0) {
    throw new RangeError(`Clamp step must be positive and finite, got ${step}`);
  }
  return step;
}
