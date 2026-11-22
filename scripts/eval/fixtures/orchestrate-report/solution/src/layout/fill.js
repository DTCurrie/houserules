import { charWidth, displayWidth } from './width.js';

/**
 * Repeat `fill` until it is `columns` wide, cutting the last repeat short. A wide fill
 * character that would straddle the last column is replaced by a space, so the result is
 * always exactly `columns` wide. A count below one gives an empty string.
 *
 * @param {string} fill
 * @param {number} columns
 */
export function repeatFill(fill, columns) {
  if (displayWidth(fill) === 0) {
    throw new TypeError(`A fill needs a visible column: ${fill}`);
  }
  const chars = [...fill];
  let out = '';
  let used = 0;
  for (let i = 0; used < columns; i += 1) {
    const char = chars[i % chars.length];
    const width = charWidth(char);
    if (used + width > columns) {
      out += ' '.repeat(columns - used);
      break;
    }
    out += char;
    used += width;
  }
  return out;
}
