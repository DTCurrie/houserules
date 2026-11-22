import { repeatFill } from './fill.js';
import { displayWidth, sliceToWidth } from './width.js';

/**
 * @typedef {{ fill?: string, truncate?: boolean, ellipsis?: string }} AlignOptions
 */

/**
 * Cut text that is wider than `width` when `truncate` is set, ending it with `ellipsis`. An
 * ellipsis wider than `width` is dropped and the text is cut bare. Text that fits, or any
 * text without `truncate`, comes back as a string unchanged.
 *
 * @param {unknown} text
 * @param {number} width
 * @param {AlignOptions} options
 */
export function fitText(text, width, options) {
  const value = String(text);
  if (!options.truncate || displayWidth(value) <= width) return value;
  const ellipsis = options.ellipsis ?? '…';
  const room = width - displayWidth(ellipsis);
  if (room < 0) return sliceToWidth(value, width);
  return sliceToWidth(value, room) + ellipsis;
}

/**
 * @param {string} text
 * @param {number} width
 */
function gapOf(text, width) {
  return Math.max(0, width - displayWidth(text));
}

/**
 * Put text at the left of `width` columns, filling the rest.
 *
 * @param {unknown} text
 * @param {number} width
 * @param {AlignOptions} [options]
 */
export function alignLeft(text, width, options = {}) {
  const value = fitText(text, width, options);
  return value + repeatFill(options.fill ?? ' ', gapOf(value, width));
}

/**
 * Put text at the right of `width` columns, filling the rest.
 *
 * @param {unknown} text
 * @param {number} width
 * @param {AlignOptions} [options]
 */
export function alignRight(text, width, options = {}) {
  const value = fitText(text, width, options);
  return repeatFill(options.fill ?? ' ', gapOf(value, width)) + value;
}

/**
 * Center text in `width` columns. An odd gap puts the extra column on the right.
 *
 * @param {unknown} text
 * @param {number} width
 * @param {AlignOptions} [options]
 */
export function alignCenter(text, width, options = {}) {
  const value = fitText(text, width, options);
  const fill = options.fill ?? ' ';
  const gap = gapOf(value, width);
  const left = Math.floor(gap / 2);
  return repeatFill(fill, left) + value + repeatFill(fill, gap - left);
}
