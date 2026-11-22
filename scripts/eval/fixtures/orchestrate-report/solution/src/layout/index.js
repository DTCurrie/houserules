import { alignCenter, alignLeft, alignRight } from './align.js';

export { displayWidth } from './width.js';

const SIDES = { start: alignRight, end: alignLeft, both: alignCenter };

/**
 * Align text in `width` columns: `left`, `right`, or `center`. Text already wider than
 * `width` comes back unchanged.
 *
 * @param {unknown} text
 * @param {number} width
 * @param {'left' | 'right' | 'center'} [how]
 * @param {string} [fill]
 */
export function align(text, width, how = 'left', fill = ' ') {
  if (how === 'left') return alignLeft(text, width, { fill });
  if (how === 'right') return alignRight(text, width, { fill });
  if (how === 'center') return alignCenter(text, width, { fill });
  throw new TypeError(`Unknown alignment: ${String(how)}`);
}

/**
 * Pad text to `width` columns. `side` is where the fill goes: `start` (the default), `end`, or
 * `both`, which centers the text. Text wider than `width` comes back unchanged, or with
 * `truncate` is cut to `width` and ends with `ellipsis` (default `…`).
 *
 * @param {unknown} text
 * @param {number} width
 * @param {{ side?: 'start' | 'end' | 'both', fill?: string, truncate?: boolean, ellipsis?: string }} [options]
 */
export function pad(text, width, options = {}) {
  if (!Number.isInteger(width) || width < 0) {
    throw new RangeError(`Pad width must be a whole number >= 0, got ${width}`);
  }
  const { side = 'start', fill = ' ', truncate = false, ellipsis } = options;
  const place = Object.hasOwn(SIDES, side) ? SIDES[side] : undefined;
  if (place === undefined) {
    throw new TypeError(`Unknown pad side: ${String(side)}`);
  }
  return place(text, width, { fill, truncate, ellipsis });
}
