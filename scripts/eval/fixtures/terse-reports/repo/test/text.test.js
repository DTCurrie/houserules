import assert from 'node:assert/strict';
import { test } from 'node:test';
import { snakeCase, titleCase, tokenize } from '../src/text/index.js';

test('tokenize splits on anything but ASCII letters and digits', () => {
  assert.deepEqual(tokenize('a1 b-2026'), [
    { value: 'a1', kind: 'word' },
    { value: 'b', kind: 'word' },
    { value: '2026', kind: 'number' },
  ]);
  assert.deepEqual(tokenize(''), []);
  assert.deepEqual(tokenize(42), [{ value: '42', kind: 'number' }]);
});

test('titleCase capitalizes each word', () => {
  assert.equal(titleCase('hello  world'), 'Hello World');
  assert.equal(titleCase('fooBar BAZ'), 'Foobar Baz');
});

test('snakeCase joins lower-cased words with underscores', () => {
  assert.equal(snakeCase('Hello World 42'), 'hello_world_42');
  assert.equal(snakeCase('--'), '');
});
