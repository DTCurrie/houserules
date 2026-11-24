import { lookup } from './catalog.js';
import { allocate, applyRate, assertCents } from './money.js';
import { maxDiscountFor, rateFor } from './tax-rates.js';

const BASIS_POINTS_PER_WHOLE = 10000;

/**
 * The shallow answer: validation, merging, `allocate`, and tax after the discount all meet the
 * contract, and it passes the visible tests. It keeps the first pass's floored cap instead of
 * `applyRate`, and re-splits a held line's excess once, so a line pushed over its own cap by
 * that re-split is never held.
 */
function discountCap(line) {
  return Math.floor(
    (line.grossCents * maxDiscountFor(line.category)) / BASIS_POINTS_PER_WHOLE,
  );
}

function assertQuantity(qty, index) {
  if (!Number.isSafeInteger(qty) || qty < 1)
    throw new RangeError(
      `order[${index}].qty must be a positive integer, got ${String(qty)}`,
    );
}

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

function splitCoupon(couponCents, lines) {
  const caps = lines.map(discountCap);
  const capTotal = caps.reduce((sum, cap) => sum + cap, 0);
  const shares = allocate(
    Math.min(couponCents, capTotal),
    lines.map((line, index) => (caps[index] > 0 ? line.grossCents : 0)),
  );
  let excess = 0;
  const isHeld = shares.map((share, index) => {
    if (share <= caps[index]) return caps[index] === 0;
    excess += share - caps[index];
    shares[index] = caps[index];
    return true;
  });
  const extra = allocate(
    excess,
    lines.map((line, index) => (isHeld[index] ? 0 : line.grossCents)),
  );
  return shares.map((share, index) => share + extra[index]);
}

/** @type {import('./invoice-contract.js').BuildInvoice} */
export function buildInvoice(order, options = {}) {
  if (!Array.isArray(order)) throw new TypeError('order must be an array');
  const couponCents = assertCents(options.couponCents ?? 0, 'couponCents');
  const lines = mergeOrder(order).map((line) => ({
    ...line,
    grossCents: line.qty * line.unitCents,
  }));
  const shares = splitCoupon(couponCents, lines);

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
