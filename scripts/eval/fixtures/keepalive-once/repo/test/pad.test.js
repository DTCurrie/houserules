import assert from 'node:assert/strict';
import { test } from 'node:test';

import { padStart } from '../src/pad.js';

test('padStart fills on the left up to the width', () => {
  assert.equal(padStart('7', 3, '0'), '007');
  assert.equal(padStart('ab', 4), '  ab');
});

test('padStart leaves text at or over the width unchanged', () => {
  assert.equal(padStart('abcd', 3), 'abcd');
});

test('padStart throws a TypeError for an empty fill', () => {
  assert.throws(() => padStart('a', 3, ''), TypeError);
});
