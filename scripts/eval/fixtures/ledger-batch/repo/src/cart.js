import { applyCoupons } from './coupon.js';
import { addCents } from './money.js';
import { cartTax } from './tax.js';

/** The cart total in cents: line subtotals, minus coupons, plus tax on the undiscounted lines. */
export function cartTotal(lines, coupons = []) {
  const subtotal = addCents(...lines.map((line) => line.cents * line.quantity));
  return addCents(applyCoupons(subtotal, coupons), cartTax(lines));
}
