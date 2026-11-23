const NUMBER = String.raw`-?\d+(?:\.\d+)?`;
const DOTTED = new RegExp(String.raw`^\s*(${NUMBER})\s*\.\.\s*(${NUMBER})\s*$`);

/**
 * Parse a range spec into `{ min, max }`. A spec is a `"min..max"` string, a `[min, max]`
 * pair, or a `{ min, max }` object. Parsing checks shape only; `validateRange` checks values.
 *
 * @param {unknown} spec
 * @returns {{ min: unknown, max: unknown }}
 */
export function parseRange(spec) {
  if (typeof spec === 'string') return parseDotted(spec);
  if (Array.isArray(spec)) {
    if (spec.length !== 2) {
      throw new TypeError(`A range pair has two values, got ${spec.length}`);
    }
    return { min: spec[0], max: spec[1] };
  }
  if (spec !== null && typeof spec === 'object') {
    return { min: spec.min, max: spec.max };
  }
  throw new TypeError(`Not a range spec: ${String(spec)}`);
}

/**
 * @param {string} spec
 */
function parseDotted(spec) {
  const match = DOTTED.exec(spec);
  if (!match) throw new SyntaxError(`Not a range: ${JSON.stringify(spec)}`);
  return { min: Number(match[1]), max: Number(match[2]) };
}
