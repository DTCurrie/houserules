import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildInvoice } from '../src/invoice.js';
import { formatInvoice } from '../src/invoice-format.js';

test('prints the receipt for a discounted two-line order', () => {
  const invoice = buildInvoice(
    [
      { sku: 'MUG-01', qty: 2, unitCents: 1250 },
      { sku: 'TEA-01', qty: 1, unitCents: 1000 },
    ],
    { couponCents: 500 },
  );
  assert.equal(
    formatInvoice(invoice),
    [
      'MUG-01     2 x   12.50 -    3.57 +    4.29 =   25.72',
      'TEA-01     1 x   10.00 -    1.43 +    0.43 =    9.00',
      'subtotal    35.00',
      'discount     5.00',
      'tax          4.72',
      'total       34.72',
    ].join('\n'),
  );
});
