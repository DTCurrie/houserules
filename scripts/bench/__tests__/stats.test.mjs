import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GATE, gateVerdict, summarize } from '../stats.mjs';

test('GATE matches the documented settings', () => {
  assert.deepEqual(
    { ...GATE },
    { statistic: 'relMad', threshold: 0.05, minSamples: 10 },
  );
});

test('odd n, unsorted', () => {
  const s = summarize([4, 10, 1.5, 3.25, 2]);
  assert.equal(s.n, 5);
  assert.equal(s.median, 3.25);
  assert.equal(s.mad, 1.25);
  assert.equal(s.relMad, 1.25 / 3.25);
  assert.equal(s.min, 1.5);
  assert.equal(s.max, 10);
  assert.equal(s.p95, 10);
});

test('even n, median is the mean of the two middle samples', () => {
  const s = summarize([11, 2, 7, 4]);
  assert.equal(s.median, 5.5);
  assert.equal(s.mad, 2.5);
  assert.equal(s.relMad, 2.5 / 5.5);
  assert.equal(s.p95, 11);
});

test('an outlier barely moves the median and MAD', () => {
  const clean = summarize([12, 10, 11, 10.5, 11.5]);
  assert.equal(clean.median, 11);
  assert.equal(clean.mad, 0.5);
  const dirty = summarize([500, 10, 11, 10.5, 11.5]);
  assert.equal(dirty.median, 11);
  assert.equal(dirty.mad, 0.5);
  assert.equal(dirty.max, 500);
});

test('p95 is nearest rank over 20 samples', () => {
  const samples = Array.from({ length: 20 }, (_, i) => (20 - i) * 1.5);
  assert.equal(summarize(samples).p95, 28.5);
});

test('single sample and zero median', () => {
  const one = summarize([7.5]);
  assert.deepEqual(one, {
    n: 1,
    median: 7.5,
    p95: 7.5,
    mad: 0,
    relMad: 0,
    min: 7.5,
    max: 7.5,
  });
  assert.equal(summarize([0, 0, 0]).relMad, 0);
});

test('does not mutate the input', () => {
  const input = [3, 1, 2];
  summarize(input);
  assert.deepEqual(input, [3, 1, 2]);
});

test('throws on empty input', () => {
  assert.throws(() => summarize([]));
});

test('gate verdict at the threshold', () => {
  assert.equal(gateVerdict({ n: 20, relMad: 0.0500001 }), 'fail');
  assert.equal(gateVerdict({ n: 20, relMad: 0.05 }), 'pass');
  assert.equal(gateVerdict({ n: 20, relMad: 0.049 }), 'pass');
});

test('gate verdict flips from insufficient at n = 10', () => {
  assert.equal(gateVerdict({ n: 9, relMad: 0.5 }), 'insufficient');
  assert.equal(gateVerdict({ n: 10, relMad: 0.5 }), 'fail');
  assert.equal(gateVerdict({ n: 10, relMad: 0.01 }), 'pass');
});

test('gate verdict honors a custom gate', () => {
  assert.equal(
    gateVerdict({ n: 3, relMad: 0.2 }, { threshold: 0.1, minSamples: 3 }),
    'fail',
  );
});
