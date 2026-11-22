/**
 * Lower-case a word token. A number token passes through unchanged.
 *
 * @param {{ value: string, kind: 'word' | 'number' }} token
 */
export function normalizeToken(token) {
  if (token.kind !== 'word') return token;
  return { ...token, value: token.value.toLowerCase() };
}

/**
 * Normalize every token, keeping their order.
 *
 * @param {{ value: string, kind: 'word' | 'number' }[]} tokens
 */
export function normalize(tokens) {
  return tokens.map(normalizeToken);
}
