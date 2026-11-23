/**
 * Whether a value lies inside a range, bounds included.
 *
 * @param {{ min: number, max: number }} range
 * @param {number} value
 */
export function contains(range, value) {
  return value >= range.min && value <= range.max;
}

/**
 * The distance from a range's min to its max.
 *
 * @param {{ min: number, max: number }} range
 */
export function width(range) {
  return range.max - range.min;
}
