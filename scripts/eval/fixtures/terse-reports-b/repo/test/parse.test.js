import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DurationError, isDuration } from '../src/duration.js';
import { parseDuration } from '../src/parse/index.js';

test('parseDuration sums its parts into one duration', () => {
  assert.equal(parseDuration('1h30m').ms, 5_400_000);
  assert.equal(parseDuration('250ms').ms, 250);
  assert.equal(parseDuration('2m5s10ms').ms, 125_010);
  assert.equal(parseDuration('0s').ms, 0);
  assert.equal(isDuration(parseDuration('45s')), true);
});

test('parseDuration reads ms as one unit, not minutes then seconds', () => {
  assert.equal(parseDuration('5ms').ms, 5);
  assert.equal(parseDuration('5m5s').ms, 305_000);
});

test('parseDuration accepts the parts in any order', () => {
  assert.equal(parseDuration('30m1h').ms, 5_400_000);
});

test('parseDuration rejects malformed text with a DurationError', () => {
  for (const text of [
    '',
    '90',
    'h',
    '1x',
    '1w',
    '1.5h',
    '-1h',
    '1h1h',
    '1h 30m!',
  ]) {
    assert.throws(
      () => parseDuration(text),
      DurationError,
      JSON.stringify(text),
    );
  }
  assert.throws(() => parseDuration(90), DurationError);
  assert.throws(() => parseDuration(null), DurationError);
});
