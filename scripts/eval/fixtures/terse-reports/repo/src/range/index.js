import { contains } from './bounds.js';
import { parseRange } from './parse.js';
import { validateRange } from './validate.js';

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
