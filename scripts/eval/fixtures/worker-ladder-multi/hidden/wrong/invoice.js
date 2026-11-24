import { lookup } from './catalog.js';
import { allocate } from './money.js';
import { rateFor } from './tax-rates.js';

const BASIS_POINTS_PER_WHOLE = 10000;

/**
 * The fix a worker makes when it reads only the failing tests: `allocate` for the coupon and tax
 * after the discount. It passes the visible tests and skips validation, merging, the voucher
 * exclusion, the coupon cap, and half-even rounding.
 *
 * @type {import('./invoice-contract.js').BuildInvoice}
 */
export function buildInvoice(order, options = {}) {
  const couponCents = options.couponCents ?? 0;
  const lines = order.map(({ sku, qty, unitCents }) => {
    const { category } = lookup(sku);
    return { sku, category, qty, unitCents, grossCents: qty * unitCents };
  });
  const subtotalCents = lines.reduce((sum, line) => sum + line.grossCents, 0);
  const shares =
    subtotalCents === 0
      ? lines.map(() => 0)
      : allocate(
          couponCents,
          lines.map((line) => line.grossCents),
        );
  lines.forEach((line, index) => {
    line.discountCents = shares[index];
    line.taxCents = Math.round(
      ((line.grossCents - line.discountCents) * rateFor(line.category)) /
        BASIS_POINTS_PER_WHOLE,
    );
    line.netCents = line.grossCents - line.discountCents + line.taxCents;
  });
  const discountCents = lines.reduce(
    (sum, line) => sum + line.discountCents,
    0,
  );
  const taxCents = lines.reduce((sum, line) => sum + line.taxCents, 0);
  return {
    lines,
    subtotalCents,
    discountCents,
    taxCents,
    totalCents: subtotalCents - discountCents + taxCents,
  };
}
