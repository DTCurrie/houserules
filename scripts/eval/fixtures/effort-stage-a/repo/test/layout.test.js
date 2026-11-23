import assert from 'node:assert/strict';
import { test } from 'node:test';
import { align, displayWidth } from '../src/layout/index.js';

test('displayWidth counts ASCII columns', () => {
  assert.equal(displayWidth('abc'), 3);
  assert.equal(displayWidth(''), 0);
});

test('align places text in a width', () => {
  assert.equal(align('7', 3, 'right', '0'), '007');
  assert.equal(align('ab', 5, 'center'), ' ab  ');
  assert.equal(align('x', 4, 'left', '-='), 'x-=-');
  assert.equal(align('abcd', 3), 'abcd');
});

test('align rejects an unknown alignment', () => {
  assert.throws(() => align('x', 2, 'up'), TypeError);
});
