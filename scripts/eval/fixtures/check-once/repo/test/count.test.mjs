import assert from 'node:assert/strict';
import { test } from 'node:test';

import { countFile } from '../src/count.mjs';

test('counts lines and words in a data file', () => {
  assert.deepEqual(countFile('data/a.txt'), { lines: 2, words: 5 });
});
