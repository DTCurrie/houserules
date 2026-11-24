import assert from 'node:assert/strict';
import { test } from 'node:test';

import { shout } from '../src/shout.js';

test('shout upper-cases and appends a bang', () => {
  assert.equal(shout('hi there'), 'HI THERE!');
});
