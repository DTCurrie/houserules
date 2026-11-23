import assert from 'node:assert/strict';
import { test } from 'node:test';
import { shout } from '../src/shout.js';

test('shout upper-cases and adds a bang', () => {
  assert.equal(shout('hi'), 'HI!');
});
