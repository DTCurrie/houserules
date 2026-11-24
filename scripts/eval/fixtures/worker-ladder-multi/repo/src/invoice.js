import { lookup } from './catalog.js';
import { rateFor } from './tax-rates.js';

const BASIS_POINTS_PER_WHOLE = 10000;

/** @type {import('./invoice-contract.js').BuildInvoice} */
export function buildInvoice(order, options = {}) {
  const couponCents = options.couponCents ?? 0;
  const lines = order.map(({ sku, qty, unitCents }) => {
    const { category } = lookup(sku);
    return { sku, category, qty, unitCents, grossCents: qty * unitCents };
  });
  const subtotalCents = lines.reduce((sum, line) => sum + line.grossCents, 0);
  for (const line of lines) {
    line.discountCents =
      subtotalCents === 0
        ? 0
        : Math.round((couponCents * line.grossCents) / subtotalCents);
    line.taxCents = Math.round(
      (line.grossCents * rateFor(line.category)) / BASIS_POINTS_PER_WHOLE,
    );
    line.netCents = line.grossCents - line.discountCents + line.taxCents;
  }
  const taxCents = lines.reduce((sum, line) => sum + line.taxCents, 0);
  return {
    lines,
    subtotalCents,
    discountCents: couponCents,
    taxCents,
    totalCents: subtotalCents - couponCents + taxCents,
  };
}
