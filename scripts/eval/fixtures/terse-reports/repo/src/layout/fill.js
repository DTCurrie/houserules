/**
 * Repeat `fill` until it is `count` characters long, cutting the last repeat short. An empty
 * fill or a count below one gives an empty string.
 *
 * @param {string} fill
 * @param {number} count
 */
export function repeatFill(fill, count) {
  const chars = [...fill];
  if (chars.length === 0 || count < 1) return '';
  let out = '';
  for (let i = 0; i < count; i += 1) out += chars[i % chars.length];
  return out;
}
