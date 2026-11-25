import assert from 'node:assert/strict';
import { test } from 'node:test';

import { reverse } from '../src/reverse.js';

test('reverse reverses the characters', () => {
  assert.equal(reverse('abc def'), 'fed cba');
});
