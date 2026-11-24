import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildInvoice } from '../src/invoice.js';
import { checkInvoice } from '../src/invoice-contract.js';

test('prices a single standard-rate line', () => {
  const invoice = buildInvoice([{ sku: 'MUG-01', qty: 2, unitCents: 1250 }]);
  assert.deepEqual(checkInvoice(invoice), []);
  assert.equal(invoice.subtotalCents, 2500);
  assert.equal(invoice.taxCents, 500);
  assert.equal(invoice.totalCents, 3000);
});

test('totals a mixed-rate order', () => {
  const invoice = buildInvoice([
    { sku: 'TEA-01', qty: 3, unitCents: 450 },
    { sku: 'KETTLE', qty: 1, unitCents: 3999 },
  ]);
  assert.deepEqual(checkInvoice(invoice), []);
  assert.deepEqual(
    invoice.lines.map((line) => line.taxCents),
    [68, 800],
  );
  assert.equal(invoice.totalCents, 6217);
});

test('splits a coupon so the line discounts sum to the invoice discount', () => {
  const invoice = buildInvoice(
    [
      { sku: 'TEA-01', qty: 1, unitCents: 1000 },
      { sku: 'BOOK-7', qty: 1, unitCents: 1000 },
      { sku: 'MUG-01', qty: 1, unitCents: 1000 },
    ],
    { couponCents: 100 },
  );
  assert.deepEqual(checkInvoice(invoice), []);
  assert.deepEqual(
    invoice.lines.map((line) => line.discountCents),
    [34, 33, 33],
  );
});

test('taxes a line on its price after the discount', () => {
  const invoice = buildInvoice([{ sku: 'MUG-01', qty: 1, unitCents: 1000 }], {
    couponCents: 200,
  });
  assert.deepEqual(checkInvoice(invoice), []);
  assert.equal(invoice.taxCents, 160);
  assert.equal(invoice.totalCents, 960);
});
