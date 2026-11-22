import { clampTo, contains } from './bounds.js';
import { parseRange } from './parse.js';
import { validateRange, validateStep } from './validate.js';

export { width } from './bounds.js';

/**
 * Parse and validate a range spec.
 *
 * @param {unknown} spec
 */
export function range(spec) {
  return validateRange(parseRange(spec));
}

/**
 * Whether `value` lies inside the range `spec` describes.
 *
 * @param {number} value
 * @param {unknown} spec
 */
export function inRange(value, spec) {
  return contains(range(spec), value);
}

/**
 * Bound `value` to the range `spec` describes. `options.step` snaps a value outside the
 * range to the nearest multiple of the step inside it.
 *
 * @param {number} value
 * @param {unknown} spec
 * @param {{ step?: number }} [options]
 */
export function clamp(value, spec, options = {}) {
  return clampTo(range(spec), value, validateStep(options.step));
}
