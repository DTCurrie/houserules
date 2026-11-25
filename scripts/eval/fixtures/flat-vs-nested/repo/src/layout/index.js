import { alignCenter, alignLeft, alignRight } from './align.js';

export { displayWidth } from './width.js';

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
  if (how === 'left') return alignLeft(text, width, fill);
  if (how === 'right') return alignRight(text, width, fill);
  if (how === 'center') return alignCenter(text, width, fill);
  throw new TypeError(`Unknown alignment: ${String(how)}`);
}
