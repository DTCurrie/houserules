const COMBINING_MARK = /^[\p{Mn}\p{Me}]$/u;
/** Zero width space, zero width non-joiner, and zero width joiner. */
const ZERO_WIDTH = [0x200b, 0x200d];

/** Code point ranges that take two columns: East Asian wide and fullwidth forms, and emoji. */
const WIDE = [
  [0x1100, 0x115f],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe30, 0xfe4f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f300, 0x1f64f],
  [0x1f900, 0x1f9ff],
  [0x20000, 0x3fffd],
];

/**
 * The number of columns one code point takes: 0 for a combining mark or a zero-width
 * character, 2 for an East Asian wide character or an emoji, and 1 for anything else.
 *
 * @param {string} char
 */
export function charWidth(char) {
  const code = /** @type {number} */ (char.codePointAt(0));
  if (COMBINING_MARK.test(char)) return 0;
  if (code >= ZERO_WIDTH[0] && code <= ZERO_WIDTH[1]) return 0;
  return WIDE.some(([low, high]) => code >= low && code <= high) ? 2 : 1;
}

/**
 * The number of columns text takes, summed over its code points.
 *
 * @param {unknown} text
 */
export function displayWidth(text) {
  let columns = 0;
  for (const char of String(text)) columns += charWidth(char);
  return columns;
}

/**
 * The longest start of text that fits in `columns`. A wide character that would straddle the
 * last column is left out, and a combining mark stays with the character before it.
 *
 * @param {unknown} text
 * @param {number} columns
 */
export function sliceToWidth(text, columns) {
  let out = '';
  let used = 0;
  for (const char of String(text)) {
    const next = used + charWidth(char);
    if (next > columns) break;
    out += char;
    used = next;
  }
  return out;
}
