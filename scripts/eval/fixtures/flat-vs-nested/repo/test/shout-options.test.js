import assert from 'node:assert/strict';
import { test } from 'node:test';
import { shout } from '../src/shout.js';

test('shout keeps its default output', () => {
  assert.equal(shout('hi'), 'HI!');
  assert.equal(shout('hi', {}), 'HI!');
});

test('bang sets the number of exclamation marks', () => {
  assert.equal(shout('hi', { bang: 3 }), 'HI!!!');
  assert.equal(shout('hi', { bang: 0 }), 'HI');
});

test('repeat says the text several times, separated by spaces', () => {
  assert.equal(shout('go', { repeat: 3 }), 'GO GO GO!');
  assert.equal(shout('go', { repeat: 2, bang: 2 }), 'GO GO!!');
});

test('a text that is not a string throws a TypeError', () => {
  assert.throws(() => shout(null), TypeError);
  assert.throws(() => shout(5), TypeError);
});

test('options that are not an object throw a TypeError', () => {
  assert.throws(() => shout('hi', null), TypeError);
  assert.throws(() => shout('hi', 'loud'), TypeError);
  assert.throws(() => shout('hi', []), TypeError);
});

test('an unknown option key throws a TypeError', () => {
  assert.throws(() => shout('hi', { volume: 11 }), TypeError);
});

test('a bang that is not a non-negative integer throws a RangeError', () => {
  assert.throws(() => shout('hi', { bang: -1 }), RangeError);
  assert.throws(() => shout('hi', { bang: 1.5 }), RangeError);
  assert.throws(() => shout('hi', { bang: '2' }), RangeError);
});

test('a repeat that is not a positive integer throws a RangeError', () => {
  assert.throws(() => shout('hi', { repeat: 0 }), RangeError);
  assert.throws(() => shout('hi', { repeat: 2.5 }), RangeError);
  assert.throws(() => shout('hi', { repeat: NaN }), RangeError);
});
