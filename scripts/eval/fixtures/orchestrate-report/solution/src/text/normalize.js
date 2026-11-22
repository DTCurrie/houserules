const STOP_WORD = /^[A-Za-z0-9]+$/;

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
 * Normalize every token, keeping their order. With `stopWords`, drop each word token that
 * matches one of them after lower-casing, unless that would drop every token, in which case
 * the tokens come back with none dropped.
 *
 * @param {{ value: string, kind: 'word' | 'number' }[]} tokens
 * @param {{ stopWords?: string[] }} [options]
 */
export function normalize(tokens, options = {}) {
  const stopWords = readStopWords(options.stopWords);
  const normalized = tokens.map(normalizeToken);
  if (stopWords.size === 0) return normalized;
  const kept = normalized.filter(
    (token) => token.kind !== 'word' || !stopWords.has(token.value),
  );
  return kept.length > 0 ? kept : normalized;
}

/**
 * @param {unknown} stopWords
 * @returns {Set<string>}
 */
function readStopWords(stopWords) {
  if (stopWords === undefined) return new Set();
  if (!Array.isArray(stopWords)) {
    throw new TypeError(`stopWords must be an array, got ${String(stopWords)}`);
  }
  const set = new Set();
  for (const word of stopWords) {
    if (typeof word !== 'string' || !STOP_WORD.test(word)) {
      throw new TypeError(`Not a stop word: ${String(word)}`);
    }
    set.add(word.toLowerCase());
  }
  return set;
}
