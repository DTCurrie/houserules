import { lookup } from './catalog.js';
import { maxDiscountFor, rateFor } from './tax-rates.js';

const BASIS_POINTS_PER_WHOLE = 10000;

/** The most a coupon may take of `line`. */
function discountCap(line) {
  return Math.floor(
    (line.grossCents * maxDiscountFor(line.category)) / BASIS_POINTS_PER_WHOLE,
  );
}

/** @type {import('./invoice-contract.js').BuildInvoice} */
export function buildInvoice(order, options = {}) {
  const couponCents = options.couponCents ?? 0;
  const lines = order.map(({ sku, qty, unitCents }) => {
    const { category } = lookup(sku);
    return { sku, category, qty, unitCents, grossCents: qty * unitCents };
  });
  const subtotalCents = lines.reduce((sum, line) => sum + line.grossCents, 0);
  for (const line of lines) {
    const share =
      subtotalCents === 0
        ? 0
        : Math.round((couponCents * line.grossCents) / subtotalCents);
    line.discountCents = Math.min(share, discountCap(line));
    line.taxCents = Math.round(
      (line.grossCents * rateFor(line.category)) / BASIS_POINTS_PER_WHOLE,
    );
    line.netCents = line.grossCents - line.discountCents + line.taxCents;
  }
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
