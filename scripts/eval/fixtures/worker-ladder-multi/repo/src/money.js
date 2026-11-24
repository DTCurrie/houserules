const BASIS_POINTS_PER_WHOLE = 10000n;
const CENTS_PER_UNIT = 100;

/**
 * Throws unless `value` is a non-negative safe integer, the only shape an amount of money takes
 * in this package.
 *
 * @param {unknown} value
 * @param {string} name Used in the error message.
 * @returns {number} `value`, unchanged.
 * @throws {RangeError}
 */
export function assertCents(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(
      `${name} must be a non-negative integer number of cents, got ${String(value)}`,
    );
  }
  return value;
}

/**
 * Applies a rate in basis points (2000 is 20%) to an amount, rounded half to even. The rounding
 * matters on exact halves: `applyRate(10, 500)` is 0 and `applyRate(30, 500)` is 2.
 *
 * @param {number} cents A non-negative integer.
 * @param {number} basisPoints A non-negative integer.
 * @returns {number} Cents, an integer.
 */
export function applyRate(cents, basisPoints) {
  const product =
    BigInt(assertCents(cents, 'cents')) *
    BigInt(assertCents(basisPoints, 'basisPoints'));
  const quotient = product / BASIS_POINTS_PER_WHOLE;
  const twiceRemainder = (product % BASIS_POINTS_PER_WHOLE) * 2n;
  if (twiceRemainder < BASIS_POINTS_PER_WHOLE) return Number(quotient);
  if (twiceRemainder > BASIS_POINTS_PER_WHOLE) return Number(quotient + 1n);
  return Number(quotient % 2n === 0n ? quotient : quotient + 1n);
}

/**
 * Splits `totalCents` across `weights` in proportion, by the largest-remainder method. The parts
 * always sum to exactly `totalCents`. A leftover cent goes to the largest remainder, and on a tie
 * to the earlier index. A zero weight always gets 0.
 *
 * @param {number} totalCents A non-negative integer.
 * @param {number[]} weights Non-negative integers.
 * @returns {number[]} One part per weight, in the same order.
 * @throws {RangeError} On a negative or fractional input, or a nonzero total over all-zero weights.
 */
export function allocate(totalCents, weights) {
  const total = BigInt(assertCents(totalCents, 'totalCents'));
  const bigWeights = weights.map((weight, index) =>
    BigInt(assertCents(weight, `weights[${index}]`)),
  );
  const weightSum = bigWeights.reduce((sum, weight) => sum + weight, 0n);
  if (weightSum === 0n) {
    if (total === 0n) return weights.map(() => 0);
    throw new RangeError(
      'cannot allocate a nonzero total over weights that are all zero',
    );
  }
  const parts = bigWeights.map((weight) => (total * weight) / weightSum);
  const remainders = bigWeights.map((weight, index) => ({
    index,
    remainder: (total * weight) % weightSum,
  }));
  let leftover = total - parts.reduce((sum, part) => sum + part, 0n);
  remainders.sort((left, right) =>
    left.remainder === right.remainder
      ? left.index - right.index
      : left.remainder > right.remainder
        ? -1
        : 1,
  );
  for (const { index } of remainders) {
    if (leftover === 0n) break;
    parts[index] += 1n;
    leftover -= 1n;
  }
  return parts.map(Number);
}

/**
 * Renders cents as a decimal amount, `1234` as `12.34`.
 *
 * @param {number} cents A non-negative integer.
 * @returns {string}
 */
export function formatCents(cents) {
  assertCents(cents, 'cents');
  const whole = Math.floor(cents / CENTS_PER_UNIT);
  const fraction = String(cents % CENTS_PER_UNIT).padStart(2, '0');
  return `${whole}.${fraction}`;
}
