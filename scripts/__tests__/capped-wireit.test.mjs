import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { wireitParallel } from '../capped-wireit.mjs';

describe('wireitParallel', () => {
  for (const [cores, expected] of [
    [2, '2'],
    [8, '2'],
    [10, '2'],
    [12, '3'],
    [32, '8'],
  ]) {
    it(`caps ${cores} cores at ${expected} scripts`, () => {
      assert.equal(wireitParallel(cores, undefined), expected);
    });
  }

  it('leaves a WIREIT_PARALLEL the caller already set alone', () => {
    assert.equal(wireitParallel(32, '5'), '5');
  });
});
