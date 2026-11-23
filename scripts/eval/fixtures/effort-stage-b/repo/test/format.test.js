import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DurationError, makeDuration } from '../src/duration.js';
import { formatDuration } from '../src/format/index.js';

test('formatDuration prints the largest units first, separated by spaces', () => {
  assert.equal(formatDuration(makeDuration(93_784_005)), '1d 2h 3m 4s 5ms');
  assert.equal(formatDuration(makeDuration(5_400_000)), '1h 30m');
  assert.equal(formatDuration(makeDuration(172_800_000)), '2d');
});

test('formatDuration leaves out the zero parts', () => {
  assert.equal(formatDuration(makeDuration(86_400_250)), '1d 250ms');
  assert.equal(formatDuration(makeDuration(61_000)), '1m 1s');
});

test('formatDuration prints a zero duration as 0s', () => {
  assert.equal(formatDuration(makeDuration(0)), '0s');
});

test('formatDuration rejects anything but a duration', () => {
  assert.throws(() => formatDuration({ ms: 5 }), DurationError);
  assert.throws(() => formatDuration(5), DurationError);
});
