/** Tax rate per catalog category, in basis points: 2000 is 20%. */
export const TAX_RATES = Object.freeze({
  standard: 2000,
  reduced: 500,
  clearance: 2000,
  voucher: 0,
});

/**
 * The most of a line's gross a coupon may take, per catalog category, in basis points. Clearance
 * stock is marked down already, so a coupon takes at most a fifth of it. A gift card is money
 * already, so a coupon never discounts one.
 */
export const MAX_DISCOUNT_RATES = Object.freeze({
  standard: 10000,
  reduced: 5000,
  clearance: 2000,
  voucher: 0,
});

/**
 * The tax rate for `category`, in basis points.
 *
 * @param {string} category
 * @returns {number}
 * @throws {RangeError} For a category with no rate.
 */
export function rateFor(category) {
  if (!Object.hasOwn(TAX_RATES, category))
    throw new RangeError(
      `no tax rate for category ${JSON.stringify(category)}`,
    );
  return TAX_RATES[category];
}

/**
 * The most a coupon may take of a line in `category`, in basis points of its gross.
 *
 * @param {string} category
 * @returns {number}
 * @throws {RangeError} For a category with no cap.
 */
export function maxDiscountFor(category) {
  if (!Object.hasOwn(MAX_DISCOUNT_RATES, category))
    throw new RangeError(
      `no discount cap for category ${JSON.stringify(category)}`,
    );
  return MAX_DISCOUNT_RATES[category];
}
