import { formatSlug, formatSnake, formatTitle } from './format.js';
import { normalize } from './normalize.js';
import { tokenize } from './tokenize.js';

export { tokenize };

/**
 * Title Case: each word capitalized, words separated by single spaces. `options` passes
 * through to `tokenize`.
 *
 * @param {unknown} text
 * @param {{ foldAccents?: boolean, splitCamel?: boolean }} [options]
 */
export function titleCase(text, options = {}) {
  return formatTitle(normalize(tokenize(text, options)));
}

/**
 * snake_case: lower-cased words joined by single underscores. `options` passes through to
 * `tokenize`.
 *
 * @param {unknown} text
 * @param {{ foldAccents?: boolean, splitCamel?: boolean }} [options]
 */
export function snakeCase(text, options = {}) {
  return formatSnake(normalize(tokenize(text, options)));
}

/**
 * A URL slug: accents folded, camelCase split, words lower-cased and joined by `separator`.
 *
 * @param {unknown} text
 * @param {{ separator?: string, maxLength?: number, stopWords?: string[] }} [options]
 */
export function slugify(text, options = {}) {
  const { separator, maxLength, stopWords } = options;
  const tokens = tokenize(text, { foldAccents: true, splitCamel: true });
  return formatSlug(normalize(tokens, { stopWords }), { separator, maxLength });
}
