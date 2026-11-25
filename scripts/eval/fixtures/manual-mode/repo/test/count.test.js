import assert from 'node:assert/strict';
import { test } from 'node:test';

import { count } from '../src/count.js';

test('count counts words', () => {
  assert.equal(count('  one two   three '), 3);
});
