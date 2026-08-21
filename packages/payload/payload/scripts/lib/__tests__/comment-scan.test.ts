import { describe, expect, it } from 'vitest';

import { scanComments } from '../comment-scan.mjs';

describe('scanComments', () => {
  it('finds a plain line comment', () => {
    expect(scanComments('const x = 1; // note')).toEqual([
      { text: '// note', line: 1, kind: 'line' },
    ]);
  });

  it('finds a block comment', () => {
    expect(scanComments('/* a block */\nconst x = 1;')).toEqual([
      { text: '/* a block */', line: 1, kind: 'block' },
    ]);
  });

  it('classifies a TSDoc block starting with double star as tsdoc', () => {
    expect(scanComments('/**\n * Does a thing.\n */\nfunction f() {}')).toEqual(
      [{ text: '/**\n * Does a thing.\n */', line: 1, kind: 'tsdoc' }],
    );
  });

  it('ignores a line-comment sequence inside a single-quoted string', () => {
    expect(scanComments("const url = 'https://example.com';")).toEqual([]);
  });

  it('ignores a line-comment sequence inside a double-quoted string', () => {
    expect(scanComments('const url = "https://example.com";')).toEqual([]);
  });

  it('ignores a line-comment sequence inside a template literal', () => {
    expect(scanComments('const url = `https://example.com`;')).toEqual([]);
  });

  it('does not stop a single-quoted string early on an escaped quote', () => {
    expect(scanComments("const s = 'it\\'s // not a comment';")).toEqual([]);
  });

  it('finds a comment written inside a template literal interpolation', () => {
    const source = 'const s = `value: ${/* inline */ 1}`;';
    expect(scanComments(source)).toEqual([
      { text: '/* inline */', line: 1, kind: 'block' },
    ]);
  });

  it('does not misread an escaped slash inside a regex literal as a comment', () => {
    expect(scanComments('const re = /https:\\/\\//;')).toEqual([]);
  });

  it('reports the correct line for a comment after several newlines', () => {
    expect(scanComments('const a = 1;\nconst b = 2;\n// third line')).toEqual([
      { text: '// third line', line: 3, kind: 'line' },
    ]);
  });
});
