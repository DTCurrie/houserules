const TOKEN = /[A-Za-z0-9]+/g;
const COMBINING_MARK = /\p{M}/gu;
/** Inside a run: a lower-case letter or digit before a capital, or a capital before a capitalized word. */
const CAMEL_BOUNDARY = /(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/;
const OPTION_KEYS = new Set(['foldAccents', 'splitCamel']);

/**
 * Split text into tokens. A token is a run of ASCII letters and digits, and everything else
 * separates tokens. A token of digits only is a number, and any other token is a word.
 *
 * `foldAccents` decomposes the text and drops its combining marks first, so an accented letter
 * becomes its base letter instead of a separator. `splitCamel` splits each run at its case
 * boundaries, so `parseHTTPResponse` gives `parse`, `HTTP`, and `Response`.
 *
 * @param {unknown} text
 * @param {{ foldAccents?: boolean, splitCamel?: boolean }} [options]
 * @returns {{ value: string, kind: 'word' | 'number' }[]}
 */
export function tokenize(text, options = {}) {
  if (text === null || text === undefined) {
    throw new TypeError(`tokenize needs text, got ${String(text)}`);
  }
  const { foldAccents = false, splitCamel = false } = readOptions(options);
  const source = foldAccents ? fold(String(text)) : String(text);
  const tokens = [];
  for (const match of source.matchAll(TOKEN)) {
    const values = splitCamel ? match[0].split(CAMEL_BOUNDARY) : [match[0]];
    for (const value of values) tokens.push({ value, kind: kindOf(value) });
  }
  return tokens;
}

/**
 * @param {unknown} options
 * @returns {{ foldAccents?: boolean, splitCamel?: boolean }}
 */
function readOptions(options) {
  if (options === null || typeof options !== 'object') {
    throw new TypeError('tokenize options must be an object');
  }
  for (const [key, value] of Object.entries(options)) {
    if (!OPTION_KEYS.has(key)) {
      throw new TypeError(`Unknown tokenize option: ${key}`);
    }
    if (value !== undefined && typeof value !== 'boolean') {
      throw new TypeError(`tokenize option ${key} must be a boolean`);
    }
  }
  return options;
}

/**
 * Decompose text and drop its combining marks: `Crème` becomes `Creme`.
 *
 * @param {string} text
 */
function fold(text) {
  return text.normalize('NFKD').replace(COMBINING_MARK, '');
}

/**
 * @param {string} value
 * @returns {'word' | 'number'}
 */
function kindOf(value) {
  return /^[0-9]+$/.test(value) ? 'number' : 'word';
}
