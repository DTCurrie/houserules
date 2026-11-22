const NUMBER = String.raw`-?\d+(?:\.\d+)?`;
const DOTTED = new RegExp(
  String.raw`^\s*(${NUMBER})?\s*\.\.\s*(${NUMBER})?\s*$`,
);
const INTERVAL = new RegExp(
  String.raw`^\s*([[(])\s*(${NUMBER})\s*,\s*(${NUMBER})\s*([\])])\s*$`,
);

/**
 * Parse a range spec into `{ min, max, minExclusive, maxExclusive }`. A spec is one of:
 *
 * - a `"min..max"` string, bounds included, where a missing `min` or `max` leaves that side
 *   open (`"0.."` has no max, `"..5"` has no min);
 * - an interval string such as `"[0, 10)"`, where `[` and `]` include a bound and `(` and `)`
 *   exclude it;
 * - a `[min, max]` pair, bounds included;
 * - a `{ min, max, minExclusive, maxExclusive }` object, where the flags default to false.
 *
 * Parsing checks shape only; `validateRange` checks values.
 *
 * @param {unknown} spec
 * @returns {{ min: unknown, max: unknown, minExclusive: unknown, maxExclusive: unknown }}
 */
export function parseRange(spec) {
  if (typeof spec === 'string') {
    return INTERVAL.test(spec) ? parseInterval(spec) : parseDotted(spec);
  }
  if (Array.isArray(spec)) {
    if (spec.length !== 2) {
      throw new TypeError(`A range pair has two values, got ${spec.length}`);
    }
    return {
      min: spec[0],
      max: spec[1],
      minExclusive: false,
      maxExclusive: false,
    };
  }
  if (spec !== null && typeof spec === 'object') {
    return {
      min: spec.min,
      max: spec.max,
      minExclusive: spec.minExclusive ?? false,
      maxExclusive: spec.maxExclusive ?? false,
    };
  }
  throw new TypeError(`Not a range spec: ${String(spec)}`);
}

/**
 * @param {string} spec
 */
function parseDotted(spec) {
  const match = DOTTED.exec(spec);
  if (!match || (match[1] === undefined && match[2] === undefined)) {
    throw new SyntaxError(`Not a range: ${JSON.stringify(spec)}`);
  }
  return {
    min: match[1] === undefined ? -Infinity : Number(match[1]),
    max: match[2] === undefined ? Infinity : Number(match[2]),
    minExclusive: false,
    maxExclusive: false,
  };
}

/**
 * @param {string} spec
 */
function parseInterval(spec) {
  const match = /** @type {RegExpExecArray} */ (INTERVAL.exec(spec));
  const [, open, min, max, close] = match;
  return {
    min: Number(min),
    max: Number(max),
    minExclusive: open === '(',
    maxExclusive: close === ')',
  };
}
