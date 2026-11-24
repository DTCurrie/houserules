import assert from 'node:assert/strict';
import { test } from 'node:test';
import { billableKg } from '../src/volume.mjs';

test('a bulky standard parcel bills by its volume', () => {
  assert.equal(
    billableKg('STD', { lengthCm: 40, widthCm: 30, heightCm: 25, kg: 2.4 }),
    6,
  );
});

test('an express box bills by its volume over its scale weight', () => {
  assert.equal(
    billableKg('EXP', { lengthCm: 60, widthCm: 40, heightCm: 40, kg: 9 }),
    23,
  );
});

test('a dense economy parcel bills by its scale weight', () => {
  assert.equal(
    billableKg('ECO', { lengthCm: 20, widthCm: 20, heightCm: 15, kg: 3.1 }),
    4,
  );
});

test('a pallet bills by its volume', () => {
  assert.equal(
    billableKg('PAL', { lengthCm: 120, widthCm: 80, heightCm: 90, kg: 140 }),
    240,
  );
});
