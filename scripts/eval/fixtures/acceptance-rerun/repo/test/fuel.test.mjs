import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fuelSurchargeCents } from '../src/fuel.mjs';

test('fuel surcharge on a January consignment', () => {
  assert.equal(fuelSurchargeCents(12600, 1), 813);
});

test('fuel surcharge on a March consignment', () => {
  assert.equal(fuelSurchargeCents(40250, 3), 2568);
});

test('fuel surcharge on a May consignment', () => {
  assert.equal(fuelSurchargeCents(8875, 5), 623);
});

test('fuel surcharge on a July consignment', () => {
  assert.equal(fuelSurchargeCents(31420, 7), 2275);
});

test('fuel surcharge on a September consignment', () => {
  assert.equal(fuelSurchargeCents(18450, 9), 1356);
});

test('fuel surcharge on a November consignment', () => {
  assert.equal(fuelSurchargeCents(26990, 11), 1870);
});

test('fuel surcharge on a December consignment', () => {
  assert.equal(fuelSurchargeCents(5530, 12), 369);
});
