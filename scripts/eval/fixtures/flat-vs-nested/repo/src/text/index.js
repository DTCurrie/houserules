import { formatSnake, formatTitle } from './format.js';
import { normalize } from './normalize.js';
import { tokenize } from './tokenize.js';

export { tokenize };

/**
 * Title Case: each word capitalized, words separated by single spaces.
 *
 * @param {unknown} text
 */
export function titleCase(text) {
  return formatTitle(normalize(tokenize(text)));
}

/**
 * snake_case: lower-cased words joined by single underscores.
 *
 * @param {unknown} text
 */
export function snakeCase(text) {
  return formatSnake(normalize(tokenize(text)));
}
