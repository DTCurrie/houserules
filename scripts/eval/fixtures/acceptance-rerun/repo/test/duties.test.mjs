import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dutyCents } from '../src/duties.mjs';

test('a parcel one cent under the allowance pays no duty', () => {
  assert.equal(dutyCents('K10', 14999), 0);
});

test('apparel pays duty on its value above the allowance', () => {
  assert.equal(dutyCents('K20', 23750), 1362);
});

test('electronics pay the steep rate on a large declared value', () => {
  assert.equal(dutyCents('K30', 61840), 7048);
});

test('printed matter pays the light rate', () => {
  assert.equal(dutyCents('K40', 84400), 1996);
});

test('spirits pay the top rate above a small allowance', () => {
  assert.equal(dutyCents('K50', 9310), 1073);
});
