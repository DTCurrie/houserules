/**
 * The number of columns text takes: one per code point.
 *
 * @param {unknown} text
 */
export function displayWidth(text) {
  return [...String(text)].length;
}
