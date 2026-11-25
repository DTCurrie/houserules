import assert from 'node:assert/strict';
import { test } from 'node:test';

import { dash } from '../src/dash.js';

test('dash joins words with hyphens', () => {
  assert.equal(dash('Hello   Big World'), 'hello-big-world');
});
