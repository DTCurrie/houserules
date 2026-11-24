import assert from 'node:assert/strict';
import { test } from 'node:test';

import { clamp } from '../src/clamp.js';

test('clamp keeps a value inside the range', () => {
  assert.equal(clamp(5, 0, 10), 5);
});

test('clamp limits a value to either bound', () => {
  assert.equal(clamp(-3, 0, 10), 0);
  assert.equal(clamp(12, 0, 10), 10);
});

test('clamp throws a RangeError when min exceeds max', () => {
  assert.throws(() => clamp(1, 10, 0), RangeError);
});
