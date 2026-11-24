import assert from 'node:assert/strict';
import { test } from 'node:test';

import { stats } from '../src/commands/stats.mjs';

test('computes words per line', () => {
  assert.equal(stats('data/a.txt').wordsPerLine, 2.5);
});
