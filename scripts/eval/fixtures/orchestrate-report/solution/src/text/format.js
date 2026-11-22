const SLUG_SEPARATORS = new Set(['-', '_', '.']);

/**
 * Upper-case the first character of a value and keep the rest.
 *
 * @param {string} value
 */
export function capitalize(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/**
 * Join tokens as capitalized words separated by single spaces.
 *
 * @param {{ value: string }[]} tokens
 */
export function formatTitle(tokens) {
  return tokens.map((token) => capitalize(token.value)).join(' ');
}

/**
 * Join token values with single underscores.
 *
 * @param {{ value: string }[]} tokens
 */
export function formatSnake(tokens) {
  return joinValues(tokens, '_', Infinity);
}

/**
 * Join token values into a slug. `separator` is `-`, `_`, or `.`, and defaults to `-`.
 * `maxLength` caps the slug's length, cutting at a token boundary; when the first token alone
 * is too long, the slug is that token cut to `maxLength`.
 *
 * @param {{ value: string }[]} tokens
 * @param {{ separator?: string, maxLength?: number }} [options]
 */
export function formatSlug(tokens, options = {}) {
  const separator = options.separator ?? '-';
  if (!SLUG_SEPARATORS.has(separator)) {
    throw new TypeError(`Slug separator must be -, _, or ., got ${separator}`);
  }
  const maxLength = options.maxLength ?? Infinity;
  const bounded = maxLength !== Infinity;
  if (bounded && (!Number.isInteger(maxLength) || maxLength < 1)) {
    throw new RangeError(`maxLength must be an integer >= 1, got ${maxLength}`);
  }
  return joinValues(tokens, separator, maxLength);
}

/**
 * Join token values with `separator`, keeping whole tokens while the result fits `maxLength`.
 *
 * @param {{ value: string }[]} tokens
 * @param {string} separator
 * @param {number} maxLength
 */
function joinValues(tokens, separator, maxLength) {
  const kept = [];
  let length = 0;
  for (const { value } of tokens) {
    const gap = kept.length === 0 ? 0 : separator.length;
    const next = length + gap + value.length;
    if (next > maxLength) break;
    kept.push(value);
    length = next;
  }
  if (kept.length === 0 && tokens.length > 0) {
    return tokens[0].value.slice(0, maxLength);
  }
  return kept.join(separator);
}
