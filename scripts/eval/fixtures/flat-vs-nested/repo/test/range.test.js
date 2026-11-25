import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inRange, range, width } from '../src/range/index.js';

test('range reads a dotted string, a pair, and an object', () => {
  assert.equal(range('1..3').min, 1);
  assert.equal(range(' -2.5 .. 4 ').min, -2.5);
  assert.equal(range([0, 2]).max, 2);
  assert.equal(range({ min: -1, max: 1 }).min, -1);
  assert.equal(width(range('2..7')), 5);
});

test('inRange includes both bounds', () => {
  assert.equal(inRange(1, '1..3'), true);
  assert.equal(inRange(3, [1, 3]), true);
  assert.equal(inRange(4, [1, 3]), false);
});

test('range rejects bad specs', () => {
  assert.throws(() => range('3..1'), RangeError);
  assert.throws(() => range('a..b'), SyntaxError);
  assert.throws(() => range({ min: '0', max: 1 }), TypeError);
  assert.throws(() => range([1, 2, 3]), TypeError);
  assert.throws(() => range(5), TypeError);
});
