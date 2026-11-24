import assert from 'node:assert/strict';
import { test } from 'node:test';

import { whisper } from '../src/whisper.js';

test('whisper lower-cases and appends an ellipsis', () => {
  assert.equal(whisper('HI There'), 'hi there...');
});
