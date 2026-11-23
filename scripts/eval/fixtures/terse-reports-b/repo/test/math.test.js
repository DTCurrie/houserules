import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DurationError, isDuration, makeDuration } from '../src/duration.js';
import {
  addDurations,
  compareDurations,
  scaleDuration,
  subtractDuration,
} from '../src/math/index.js';

const of = (ms) => makeDuration(ms);

test('addDurations sums any number of durations', () => {
  assert.equal(addDurations(of(1), of(2), of(3)).ms, 6);
  assert.equal(addDurations().ms, 0);
  assert.equal(isDuration(addDurations(of(4))), true);
});

test('subtractDuration takes the second from the first', () => {
  assert.equal(subtractDuration(of(10), of(4)).ms, 6);
  assert.equal(subtractDuration(of(4), of(4)).ms, 0);
  assert.throws(() => subtractDuration(of(4), of(10)), DurationError);
});

test('compareDurations orders two durations', () => {
  assert.equal(compareDurations(of(1), of(2)), -1);
  assert.equal(compareDurations(of(2), of(2)), 0);
  assert.equal(compareDurations(of(3), of(2)), 1);
});

test('scaleDuration multiplies and rounds to the nearest millisecond', () => {
  assert.equal(scaleDuration(of(10), 2.5).ms, 25);
  assert.equal(scaleDuration(of(3), 0.5).ms, 2);
  assert.equal(scaleDuration(of(3), 0).ms, 0);
  for (const factor of [-1, NaN, Infinity, '2']) {
    assert.throws(
      () => scaleDuration(of(3), factor),
      DurationError,
      String(factor),
    );
  }
});

test('every function rejects an argument that is not a duration', () => {
  assert.throws(() => addDurations(of(1), { ms: 1 }), DurationError);
  assert.throws(() => subtractDuration(5, of(1)), DurationError);
  assert.throws(() => compareDurations(of(1), null), DurationError);
  assert.throws(() => scaleDuration({ ms: 1 }, 2), DurationError);
});
