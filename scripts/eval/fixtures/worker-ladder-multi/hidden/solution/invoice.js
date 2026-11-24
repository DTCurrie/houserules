import { lookup } from './catalog.js';
import { allocate, applyRate, assertCents } from './money.js';
import { rateFor, UNDISCOUNTABLE_CATEGORIES } from './tax-rates.js';

function assertQuantity(qty, index) {
  if (!Number.isSafeInteger(qty) || qty < 1)
    throw new RangeError(
      `order[${index}].qty must be a positive integer, got ${String(qty)}`,
    );
}

/** Validates each order line and merges repeated SKUs, keeping first-seen order. */
function mergeOrder(order) {
  const bySku = new Map();
  order.forEach(({ sku, qty, unitCents }, index) => {
    assertQuantity(qty, index);
    assertCents(unitCents, `order[${index}].unitCents`);
    const { category } = lookup(sku);
    const seen = bySku.get(sku);
    if (seen === undefined) {
      bySku.set(sku, { sku, category, qty, unitCents });
      return;
    }
    if (seen.unitCents !== unitCents)
      throw new RangeError(
        `sku ${sku} appears at ${seen.unitCents} and ${unitCents} cents`,
      );
    seen.qty += qty;
  });
  return [...bySku.values()];
}

/** @type {import('./invoice-contract.js').BuildInvoice} */
export function buildInvoice(order, options = {}) {
  if (!Array.isArray(order)) throw new TypeError('order must be an array');
  const couponCents = assertCents(options.couponCents ?? 0, 'couponCents');
  const lines = mergeOrder(order).map((line) => ({
    ...line,
    grossCents: line.qty * line.unitCents,
  }));

  const isDiscountable = (line) =>
    !UNDISCOUNTABLE_CATEGORIES.includes(line.category);
  const weights = lines.map((line) =>
    isDiscountable(line) ? line.grossCents : 0,
  );
  const discountableCents = weights.reduce((sum, weight) => sum + weight, 0);
  const shares = allocate(Math.min(couponCents, discountableCents), weights);

  const invoiceLines = lines.map((line, index) => {
    const discountCents = shares[index];
    const taxCents = applyRate(
      line.grossCents - discountCents,
      rateFor(line.category),
    );
    return {
      ...line,
      discountCents,
      taxCents,
      netCents: line.grossCents - discountCents + taxCents,
    };
  });
  const sum = (field) =>
    invoiceLines.reduce((total, line) => total + line[field], 0);
  const subtotalCents = sum('grossCents');
  const discountCents = sum('discountCents');
  const taxCents = sum('taxCents');
  return {
    lines: invoiceLines,
    subtotalCents,
    discountCents,
    taxCents,
    totalCents: subtotalCents - discountCents + taxCents,
  };
}
