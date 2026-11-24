import assert from 'node:assert/strict';
import { test } from 'node:test';

import { loadConfig } from '../src/config.mjs';

test('falls back to defaults when the file is absent', () => {
  assert.equal(loadConfig('missing.json').dataDir, 'data');
});
