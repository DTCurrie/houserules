/** Applies every coupon in order. Each one takes its percent off the running total. */
export function applyCoupons(totalCents, coupons) {
  let total = totalCents;
  for (const coupon of coupons) {
    total -= Math.round((total * coupon.percent) / 100);
  }
  return total;
}
