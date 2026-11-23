import assert from 'node:assert/strict';
import { test } from 'node:test';
import { elapsed } from '../src/clock/index.js';

test('elapsed returns the milliseconds between two instants', () => {
  assert.equal(elapsed(1000, 4500), 3500);
  assert.equal(elapsed(7, 7), 0);
  assert.throws(() => elapsed(5, 4), RangeError);
  assert.throws(() => elapsed('1', 2), TypeError);
});
