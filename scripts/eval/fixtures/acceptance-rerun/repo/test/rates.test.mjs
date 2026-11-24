import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rateCents } from '../src/rates.mjs';

test('a light parcel in the home zone pays one started kilogram', () => {
  assert.equal(rateCents(1, 750), 597);
});

test('a mid-zone parcel rounds its weight up', () => {
  assert.equal(rateCents(4, 3200), 1262);
});

test('a twelve-kilogram parcel to the outer ring', () => {
  assert.equal(rateCents(6, 12000), 3217);
});

test('one gram over a kilogram starts a second kilogram in the far zone', () => {
  assert.equal(rateCents(8, 1001), 1433);
});

test('an exact five kilograms in the near ring', () => {
  assert.equal(rateCents(3, 5000), 1320);
});

test('a heavy parcel to the remote ring', () => {
  assert.equal(rateCents(7, 22450), 6143);
});
