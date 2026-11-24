import assert from 'node:assert/strict';
import { test } from 'node:test';

import { cartTotal } from '../src/cart.js';
import { formatMoney } from '../src/money.js';

test('totals a two-line cart with tax', () => {
  const lines = [
    { cents: 1000, quantity: 2 },
    { cents: 250, quantity: 1 },
  ];
  assert.equal(cartTotal(lines), 2430);
});

test('formats cents as dollars', () => {
  assert.equal(formatMoney(1905), '$19.05');
});
