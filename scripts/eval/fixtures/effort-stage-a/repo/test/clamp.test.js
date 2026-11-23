import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clamp, inRange, range } from '../src/range/index.js';

test('clamp bounds a number to any range spec', () => {
  assert.equal(clamp(5, '0..3'), 3);
  assert.equal(clamp(-1, [0, 3]), 0);
  assert.equal(clamp(2, { min: 0, max: 3 }), 2);
  assert.equal(clamp(-7.5, '-10..-5'), -7.5);
  assert.throws(() => clamp(1, '3..0'), RangeError);
  assert.throws(() => clamp(Number.NaN, '0..3'), TypeError);
  assert.throws(() => clamp('2', '0..3'), TypeError);
});

test('a dotted range can leave either side open', () => {
  assert.equal(clamp(100, '0..'), 100);
  assert.equal(clamp(-4, '0..'), 0);
  assert.equal(clamp(9, '..5'), 5);
  assert.equal(range('..5').min, -Infinity);
  assert.throws(() => range('..'), SyntaxError);
});

test('an interval range excludes a bound with a parenthesis', () => {
  assert.deepEqual(range('[1, 5)'), {
    min: 1,
    max: 5,
    minExclusive: false,
    maxExclusive: true,
  });
  assert.equal(inRange(5, '[1, 5)'), false);
  assert.equal(inRange(1, '(1, 5]'), false);
  assert.equal(inRange(5, '(1, 5]'), true);
  assert.equal(inRange(1, { min: 1, max: 2, minExclusive: true }), false);
  assert.throws(() => range('[1, 5'), SyntaxError);
});

test('range rejects an empty interval and bad flags', () => {
  assert.throws(() => range('(2, 2)'), RangeError);
  assert.throws(() => range('[2, 2)'), RangeError);
  assert.equal(range('[2, 2]').max, 2);
  assert.throws(
    () => range({ min: 0, max: 1, minExclusive: 'yes' }),
    TypeError,
  );
  assert.throws(() => range({ min: Infinity, max: Infinity }), RangeError);
});

test('clamp snaps to a step, which an excluded bound needs', () => {
  assert.equal(clamp(10, '[0, 10)', { step: 1 }), 9);
  assert.equal(clamp(-3, '(0, 4]', { step: 0.5 }), 0.5);
  assert.equal(clamp(11, '[0, 10]', { step: 3 }), 9);
  assert.equal(clamp(4.2, '[0, 10]', { step: 3 }), 4.2);
  assert.throws(() => clamp(10, '[0, 10)'), RangeError);
  assert.throws(() => clamp(1, '[0, 1]', { step: 0 }), RangeError);
  assert.throws(() => clamp(1, '[0, 1]', { step: Infinity }), RangeError);
  assert.throws(() => clamp(1, '(0.2, 0.4)', { step: 1 }), RangeError);
});
