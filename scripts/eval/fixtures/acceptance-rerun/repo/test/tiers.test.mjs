import assert from 'node:assert/strict';
import { test } from 'node:test';
import { discountCents, tierFor } from '../src/tiers.mjs';

test('one cent short of the first threshold stays in the entry tier', () => {
  assert.equal(tierFor(249999), 'slate');
});

test('spend exactly on a threshold reaches that tier', () => {
  assert.equal(tierFor(900000), 'cobalt');
});

test('spend past the top threshold reaches the top tier', () => {
  assert.equal(tierFor(3100000), 'iridium');
});

test('a second-tier account discounts its invoice', () => {
  assert.equal(discountCents(410000, 58320), 1021);
});

test('a third-tier account discounts its invoice', () => {
  assert.equal(discountCents(1250000, 77410), 2632);
});

test('a top-tier account discounts a small invoice', () => {
  assert.equal(discountCents(2400000, 19990), 1029);
});
