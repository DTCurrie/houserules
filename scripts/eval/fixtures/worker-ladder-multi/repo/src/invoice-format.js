import { formatCents } from './money.js';

const SKU_WIDTH = 8;
const QTY_WIDTH = 3;
const AMOUNT_WIDTH = 8;

const amount = (cents) => formatCents(cents).padStart(AMOUNT_WIDTH);

/**
 * Renders an invoice as the plain-text receipt checkout prints, one row per line, then the totals.
 *
 * @param {import('./invoice-contract.js').Invoice} invoice
 * @returns {string}
 */
export function formatInvoice(invoice) {
  const rows = invoice.lines.map(
    (line) =>
      `${line.sku.padEnd(SKU_WIDTH)} ${String(line.qty).padStart(QTY_WIDTH)} x${amount(line.unitCents)} -${amount(line.discountCents)} +${amount(line.taxCents)} =${amount(line.netCents)}`,
  );
  return [
    ...rows,
    `subtotal ${amount(invoice.subtotalCents)}`,
    `discount ${amount(invoice.discountCents)}`,
    `tax      ${amount(invoice.taxCents)}`,
    `total    ${amount(invoice.totalCents)}`,
  ].join('\n');
}
