import assert from 'node:assert/strict';
import { test } from 'node:test';
import { slugify, snakeCase, titleCase, tokenize } from '../src/text/index.js';

const values = (tokens) => tokens.map((token) => token.value);

test('tokenize folds accents and splits camelCase on request', () => {
  assert.deepEqual(
    values(tokenize('parseHTTPResponse', { splitCamel: true })),
    ['parse', 'HTTP', 'Response'],
  );
  assert.deepEqual(values(tokenize('Crème brûlée', { foldAccents: true })), [
    'Creme',
    'brulee',
  ]);
  assert.deepEqual(values(tokenize('Crème')), ['Cr', 'me']);
  assert.throws(() => tokenize(null), TypeError);
  assert.throws(() => tokenize('a', { splitCamel: 'yes' }), TypeError);
  assert.throws(() => tokenize('a', { lower: true }), TypeError);
});

test('titleCase and snakeCase pass tokenize options through', () => {
  assert.equal(titleCase('fooBar', { splitCamel: true }), 'Foo Bar');
  assert.equal(
    snakeCase('Éclair au café', { foldAccents: true }),
    'eclair_au_cafe',
  );
});

test('slugify folds, splits, and joins with dashes', () => {
  assert.equal(slugify('Hello  World'), 'hello-world');
  assert.equal(slugify(' A, B! '), 'a-b');
  assert.equal(slugify('---'), '');
  assert.equal(slugify(42), '42');
  assert.equal(slugify('Crème Brûlée'), 'creme-brulee');
  assert.equal(slugify('parseHTTPResponse v2'), 'parse-http-response-v2');
});

test('slugify takes a separator from - _ .', () => {
  assert.equal(slugify('Hello World', { separator: '_' }), 'hello_world');
  assert.equal(slugify('Hello World', { separator: '.' }), 'hello.world');
  assert.throws(() => slugify('Hello World', { separator: '/' }), TypeError);
});

test('slugify cuts to maxLength at a token boundary', () => {
  assert.equal(slugify('The quick brown fox', { maxLength: 13 }), 'the-quick');
  assert.equal(
    slugify('The quick brown fox', { maxLength: 15 }),
    'the-quick-brown',
  );
  assert.equal(slugify('Supercalifragilistic', { maxLength: 5 }), 'super');
  assert.throws(() => slugify('a', { maxLength: 0 }), RangeError);
  assert.throws(() => slugify('a', { maxLength: 2.5 }), RangeError);
});

test('slugify drops stop words unless none would be left', () => {
  assert.equal(
    slugify('The Lord of the Rings', { stopWords: ['the', 'OF'] }),
    'lord-rings',
  );
  assert.equal(slugify('The The', { stopWords: ['the'] }), 'the-the');
  assert.equal(
    slugify('Top 10 of 2026', { stopWords: ['of', '10'] }),
    'top-10-2026',
  );
  assert.throws(() => slugify('a', { stopWords: 'the' }), TypeError);
  assert.throws(() => slugify('a', { stopWords: ['two words'] }), TypeError);
});
