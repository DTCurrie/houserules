import assert from 'node:assert/strict';
import { test } from 'node:test';

import { title } from '../src/title.js';

test('title capitalizes each word', () => {
  assert.equal(title('hELLO big wORLD'), 'Hello Big World');
});
