/** Tax rate per catalog category, in basis points: 2000 is 20%. */
export const TAX_RATES = Object.freeze({
  standard: 2000,
  reduced: 500,
  voucher: 0,
});

/**
 * Categories a coupon may never discount. A gift card is money already, so discounting one would
 * hand out cash.
 */
export const UNDISCOUNTABLE_CATEGORIES = Object.freeze(['voucher']);

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
