import assert from 'node:assert/strict';
import { test } from 'node:test';
import { etaDays } from '../src/depots.mjs';

test('a morning booking at the northern depot leaves the same day', () => {
  assert.equal(etaDays('BLY', 9), 3);
});

test('a booking on the cutoff hour waits a day', () => {
  assert.equal(etaDays('ELK', 14), 3);
});

test('a late afternoon booking at the coastal depot makes the cutoff', () => {
  assert.equal(etaDays('DUW', 17), 4);
});

test('an evening booking at the island depot adds a day to the longest transit', () => {
  assert.equal(etaDays('FEN', 19), 6);
});

test('the hub-adjacent depot turns a cutoff booking around in two days', () => {
  assert.equal(etaDays('CRN', 15), 2);
});
