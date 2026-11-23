import assert from 'node:assert/strict';
import { test } from 'node:test';
import { align, displayWidth, pad } from '../src/layout/index.js';

test('displayWidth counts wide characters as two and marks as none', () => {
  assert.equal(displayWidth('日本'), 4);
  assert.equal(displayWidth('e\u0301'), 1);
  assert.equal(displayWidth('a🙂b'), 4);
});

test('pad fills the start, the end, or both sides', () => {
  assert.equal(pad('7', 3, { fill: '0' }), '007');
  assert.equal(pad('ab', 5, { side: 'end', fill: '.' }), 'ab...');
  assert.equal(pad('ab', 6, { side: 'both', fill: '*' }), '**ab**');
  assert.equal(pad('ab', 5, { side: 'both' }), ' ab  ');
  assert.equal(pad('x', 4, { fill: '-=' }), '-=-x');
  assert.equal(pad(5, 2), ' 5');
  assert.equal(pad('abcd', 3), 'abcd');
});

test('pad measures in columns, not code points', () => {
  assert.equal(pad('日本', 6), '  日本');
  assert.equal(pad('e\u0301', 3, { side: 'end', fill: '.' }), 'e\u0301..');
  assert.equal(pad('x', 4, { fill: '日' }), '日 x');
  assert.equal(align('x', 5, 'left', '日'), 'x日日');
});

test('pad cuts wide text with an ellipsis on request', () => {
  assert.equal(pad('abcdef', 4, { truncate: true }), 'abc…');
  assert.equal(pad('abcdef', 4, { truncate: true, ellipsis: '' }), 'abcd');
  assert.equal(pad('abcdef', 4, { truncate: true, ellipsis: '.....' }), 'abcd');
  assert.equal(pad('日本語', 5, { truncate: true }), '日本…');
  assert.equal(pad('日本語', 4, { truncate: true }), ' 日…');
  assert.equal(pad('abc', 3, { truncate: true }), 'abc');
});

test('pad rejects a bad width, side, or fill', () => {
  assert.throws(() => pad('x', -1), RangeError);
  assert.throws(() => pad('x', 2.5), RangeError);
  assert.throws(() => pad('x', 3, { side: 'middle' }), TypeError);
  assert.throws(() => pad('x', 3, { side: 'toString' }), TypeError);
  assert.throws(() => pad('x', 3, { fill: '' }), TypeError);
  assert.throws(() => pad('x', 3, { fill: '\u0301' }), TypeError);
});
