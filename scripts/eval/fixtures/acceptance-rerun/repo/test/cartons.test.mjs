import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cartonsNeeded, packedGrams } from '../src/cartons.mjs';

test('nineteen items need three mid-size cartons', () => {
  assert.equal(cartonsNeeded('C3', 19), 3);
});

test('a thirteen-item order packs into small cartons at its gross weight', () => {
  assert.equal(packedGrams('C2', 13, 240), 3612);
});

test('a full large carton weighs its tare plus its items', () => {
  assert.equal(packedGrams('C5', 16, 85), 1737);
});

test('heavy items overflow the smallest carton', () => {
  assert.equal(packedGrams('C1', 9, 410), 4044);
});

test('light items spill into a third bulk carton', () => {
  assert.equal(packedGrams('C6', 41, 37), 2873);
});
