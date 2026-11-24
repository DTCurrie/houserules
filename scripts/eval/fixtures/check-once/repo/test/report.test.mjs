import assert from 'node:assert/strict';
import { test } from 'node:test';

import { reportAll } from '../src/count.mjs';

test('reports every txt file as text', () => {
  assert.equal(
    reportAll('data', 'text'),
    'a.txt: 2 lines, 5 words\nb.txt: 1 lines, 2 words\nc.txt: 1 lines, 3 words',
  );
});
