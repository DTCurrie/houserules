import { applyRate } from './money.js';
import { maxDiscountFor } from './tax-rates.js';

/**
 * One line of an order, as checkout sends it.
 *
 * @typedef {object} OrderLine
 * @property {string} sku A SKU from `src/catalog.js`.
 * @property {number} qty A positive integer.
 * @property {number} unitCents The price of one unit, a non-negative integer of cents.
 */

/**
 * @typedef {object} InvoiceOptions
 * @property {number} [couponCents] A coupon's face value, a non-negative integer of cents. Default 0.
 */

/**
 * @typedef {object} InvoiceLine
 * @property {string} sku
 * @property {string} category The catalog category of `sku`.
 * @property {number} qty
 * @property {number} unitCents
 * @property {number} grossCents `qty * unitCents`.
 * @property {number} discountCents This line's share of the coupon.
 * @property {number} taxCents Tax on `grossCents - discountCents`.
 * @property {number} netCents `grossCents - discountCents + taxCents`.
 */

/**
 * @typedef {object} Invoice
 * @property {InvoiceLine[]} lines
 * @property {number} subtotalCents The sum of every line's `grossCents`.
 * @property {number} discountCents The sum of every line's `discountCents`.
 * @property {number} taxCents The sum of every line's `taxCents`.
 * @property {number} totalCents `subtotalCents - discountCents + taxCents`.
 */

/**
 * The contract `src/invoice.js` exports as `buildInvoice`. `src/invoice-format.js` and checkout
 * consume what it returns. Every amount is an integer number of cents, and no step does money
 * arithmetic in floats.
 *
 * 1. Validation. A non-array `order` throws a `TypeError`. A `qty` that is not a positive
 *    integer, a `unitCents` that is not a non-negative integer, or a `couponCents` that is not a
 *    non-negative integer throws a `RangeError`. An unknown SKU throws the `UnknownSkuError` from
 *    `src/catalog.js`, unwrapped. The order objects are never mutated.
 * 2. Merging. Order lines with the same SKU become one invoice line, at the position of the first,
 *    with their quantities summed. The same SKU at two different `unitCents` throws a `RangeError`.
 * 3. Coupon. Each line's cap is `applyRate(grossCents, maxDiscountFor(category))`, with
 *    `maxDiscountFor` from `src/tax-rates.js`. The coupon is capped at the sum of the line caps,
 *    and the capped amount is spent in full: the invoice `discountCents` equals it, and no line's
 *    `discountCents` exceeds that line's cap. The split is `allocate` from `src/money.js` across
 *    the lines with a nonzero cap, weighted by `grossCents`. A line whose share is over its cap
 *    is held at its cap, and the capped coupon less the held lines' caps is split again by
 *    `allocate` across the lines not held, weighted by `grossCents`. The split is done only when
 *    no line's share is over its cap.
 * 4. Tax. Each line's `taxCents` is `applyRate(grossCents - discountCents, rateFor(category))`,
 *    with `applyRate` from `src/money.js` and `rateFor` from `src/tax-rates.js`. Tax is figured
 *    per line, never on a total.
 * 5. An empty order returns no lines and every total 0, whatever the coupon.
 *
 * Every invoice `buildInvoice` returns gives `[]` from `checkInvoice`.
 *
 * @callback BuildInvoice
 * @param {OrderLine[]} order
 * @param {InvoiceOptions} [options]
 * @returns {Invoice}
 */

const CENTS_FIELDS = [
  'subtotalCents',
  'discountCents',
  'taxCents',
  'totalCents',
];
const LINE_CENTS_FIELDS = [
  'unitCents',
  'grossCents',
  'discountCents',
  'taxCents',
  'netCents',
];

/**
 * The invariants `invoice` breaks, one message each. An invoice that keeps them all gives `[]`.
 *
 * @param {Invoice} invoice
 * @returns {string[]}
 */
export function checkInvoice(invoice) {
  const broken = [];
  for (const field of CENTS_FIELDS) {
    if (!Number.isSafeInteger(invoice[field]))
      broken.push(`${field} is not an integer: ${invoice[field]}`);
  }
  invoice.lines.forEach((line, index) => {
    for (const field of LINE_CENTS_FIELDS) {
      if (!Number.isSafeInteger(line[field]))
        broken.push(
          `lines[${index}].${field} is not an integer: ${line[field]}`,
        );
    }
    if (line.grossCents !== line.qty * line.unitCents)
      broken.push(`lines[${index}].grossCents is not qty * unitCents`);
    if (
      Number.isSafeInteger(line.grossCents) &&
      line.grossCents >= 0 &&
      line.discountCents >
        applyRate(line.grossCents, maxDiscountFor(line.category))
    )
      broken.push(`lines[${index}].discountCents exceeds its cap`);
    if (line.netCents !== line.grossCents - line.discountCents + line.taxCents)
      broken.push(`lines[${index}].netCents is not gross - discount + tax`);
  });
  const sum = (field) =>
    invoice.lines.reduce((total, line) => total + line[field], 0);
  if (invoice.subtotalCents !== sum('grossCents'))
    broken.push(
      `subtotalCents ${invoice.subtotalCents} is not the line gross sum ${sum('grossCents')}`,
    );
  if (invoice.discountCents !== sum('discountCents'))
    broken.push(
      `discountCents ${invoice.discountCents} is not the line discount sum ${sum('discountCents')}`,
    );
  if (invoice.taxCents !== sum('taxCents'))
    broken.push(
      `taxCents ${invoice.taxCents} is not the line tax sum ${sum('taxCents')}`,
    );
  if (
    invoice.totalCents !==
    invoice.subtotalCents - invoice.discountCents + invoice.taxCents
  )
    broken.push('totalCents is not subtotal - discount + tax');
  return broken;
}
