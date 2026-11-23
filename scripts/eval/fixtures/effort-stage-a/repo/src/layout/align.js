import { repeatFill } from './fill.js';
import { displayWidth } from './width.js';

/**
 * @param {unknown} text
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
 * @param {string} [fill]
 */
export function alignLeft(text, width, fill = ' ') {
  return String(text) + repeatFill(fill, gapOf(text, width));
}

/**
 * Put text at the right of `width` columns, filling the rest.
 *
 * @param {unknown} text
 * @param {number} width
 * @param {string} [fill]
 */
export function alignRight(text, width, fill = ' ') {
  return repeatFill(fill, gapOf(text, width)) + String(text);
}

/**
 * Center text in `width` columns. An odd gap puts the extra column on the right.
 *
 * @param {unknown} text
 * @param {number} width
 * @param {string} [fill]
 */
export function alignCenter(text, width, fill = ' ') {
  const gap = gapOf(text, width);
  const left = Math.floor(gap / 2);
  return repeatFill(fill, left) + String(text) + repeatFill(fill, gap - left);
}
