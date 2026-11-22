const TOKEN = /[A-Za-z0-9]+/g;

/**
 * Split text into tokens. A token is a run of ASCII letters and digits, and everything else
 * separates tokens. A token of digits only is a number, and any other token is a word.
 *
 * @param {unknown} text
 * @returns {{ value: string, kind: 'word' | 'number' }[]}
 */
export function tokenize(text) {
  const tokens = [];
  for (const match of String(text).matchAll(TOKEN)) {
    tokens.push({ value: match[0], kind: kindOf(match[0]) });
  }
  return tokens;
}

/**
 * @param {string} value
 * @returns {'word' | 'number'}
 */
function kindOf(value) {
  return /^[0-9]+$/.test(value) ? 'number' : 'word';
}
