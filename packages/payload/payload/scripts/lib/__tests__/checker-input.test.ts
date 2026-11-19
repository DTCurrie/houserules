import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readCheckerInputs } from '../checker-input.mjs';

describe('readCheckerInputs', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'checker-input-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns a readable file with its text and reports nothing unreadable', () => {
    const file = join(dir, 'a.md');
    writeFileSync(file, 'hello\n');

    const result = readCheckerInputs([file]);

    expect(result.inputs).toEqual([{ path: file, text: 'hello\n' }]);
    expect(result.unreadable).toEqual([]);
  });

  it('reports a missing path as an unreadable error naming the path given', () => {
    const missing = join(dir, 'missing.md');

    const result = readCheckerInputs([missing]);

    expect(result.inputs).toEqual([]);
    expect(result.unreadable).toHaveLength(1);
    expect(result.unreadable[0]).toMatchObject({
      rule: 'checker/unreadable-input',
      level: 'error',
      file: missing,
    });
  });

  it('reports a directory as unreadable', () => {
    const sub = join(dir, 'sub');
    mkdirSync(sub);

    const result = readCheckerInputs([sub]);

    expect(result.inputs).toEqual([]);
    expect(result.unreadable.map((finding) => finding.file)).toEqual([sub]);
  });

  it('keeps argument order across readable and unreadable paths', () => {
    const first = join(dir, 'first.md');
    const second = join(dir, 'second.md');
    const missing = join(dir, 'missing.md');
    writeFileSync(first, '1');
    writeFileSync(second, '2');

    const result = readCheckerInputs([second, missing, first]);

    expect(result.inputs.map((input) => input.path)).toEqual([second, first]);
    expect(result.unreadable.map((finding) => finding.file)).toEqual([missing]);
  });
});
