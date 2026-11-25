const KNOWN = ['bang', 'repeat'];

export function shout(text, options = {}) {
  if (typeof text !== 'string') throw new TypeError('text must be a string');
  if (
    options === null ||
    typeof options !== 'object' ||
    Array.isArray(options)
  ) {
    throw new TypeError('options must be an object');
  }
  for (const key of Object.keys(options)) {
    if (!KNOWN.includes(key)) throw new TypeError(`unknown option: ${key}`);
  }
  const { bang = 1, repeat = 1 } = options;
  if (!Number.isInteger(bang) || bang < 0) {
    throw new RangeError('bang must be a non-negative integer');
  }
  if (!Number.isInteger(repeat) || repeat < 1) {
    throw new RangeError('repeat must be a positive integer');
  }
  return `${Array(repeat).fill(text.toUpperCase()).join(' ')}${'!'.repeat(bang)}`;
}
