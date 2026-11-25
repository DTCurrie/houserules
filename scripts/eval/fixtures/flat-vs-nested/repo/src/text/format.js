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
  return tokens.map((token) => token.value).join('_');
}
