import assert from 'node:assert/strict';
import { test } from 'node:test';
import { zoneFor, zoneSpan } from '../src/zones.mjs';

test('a lowercase postcode finds its depot zone', () => {
  assert.equal(zoneFor('duw-118'), 6);
});

test('a postcode without a separator finds its depot zone', () => {
  assert.equal(zoneFor('HAX9'), 7);
});

test('the widest span crosses every zone', () => {
  assert.equal(zoneSpan('ARV-2', 'FEN-7'), 8);
});

test('a span counts both end zones', () => {
  assert.equal(zoneSpan('GOR4', 'BLY1'), 3);
});

test('a span inside one depot covers one zone', () => {
  assert.equal(zoneSpan('DUW-3', 'DUW-8'), 1);
});
