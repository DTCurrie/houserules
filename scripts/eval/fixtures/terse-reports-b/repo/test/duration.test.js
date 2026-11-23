import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DurationError, isDuration, makeDuration } from '../src/duration.js';

test('makeDuration returns a frozen duration of whole milliseconds', () => {
  const duration = makeDuration(1500);
  assert.deepEqual({ ...duration }, { ms: 1500 });
  assert.equal(Object.isFrozen(duration), true);
  assert.equal(makeDuration(0).ms, 0);
});

test('makeDuration rejects anything but a non-negative safe integer', () => {
  for (const ms of [-1, 1.5, NaN, Infinity, 2 ** 53, '5', null]) {
    assert.throws(
      () => makeDuration(ms),
      DurationError,
      `makeDuration(${String(ms)})`,
    );
  }
});

test('DurationError is an Error named DurationError', () => {
  const error = new DurationError('bad');
  assert.equal(error instanceof Error, true);
  assert.equal(error.name, 'DurationError');
  assert.equal(error.message, 'bad');
});

test('isDuration accepts only what makeDuration made', () => {
  assert.equal(isDuration(makeDuration(3)), true);
  assert.equal(isDuration({ ms: 3 }), false);
  assert.equal(isDuration(Object.freeze({ ms: 3 })), false);
  assert.equal(isDuration(null), false);
});
