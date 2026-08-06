import { describe, expect, it } from 'vitest';

import { wrap } from '../ui.js';

describe('wrap', () => {
  it('breaks a plain line at the last word that fits', () => {
    expect(wrap('alpha beta gamma', 11)).toBe('alpha beta\ngamma');
  });

  it('lets a single over-long token overflow rather than splitting it', () => {
    expect(wrap('/a/very/long/absolute/path', 8)).toBe(
      '/a/very/long/absolute/path',
    );
  });

  it('keeps a bullet marker on the same line as an item too long to fit', () => {
    expect(wrap('- /a/very/long/absolute/path', 8)).toBe(
      '- /a/very/long/absolute/path',
    );
  });

  it('keeps a numbered marker on the same line as an item too long to fit', () => {
    expect(wrap('1. /a/very/long/absolute/path', 8)).toBe(
      '1. /a/very/long/absolute/path',
    );
  });

  it('hangs a wrapped list item under its text rather than under the marker', () => {
    expect(wrap('- alpha beta gamma delta', 12)).toBe(
      '- alpha beta\n  gamma\n  delta',
    );
  });

  it('preserves the existing indent of an indented list item', () => {
    expect(wrap('  - /a/very/long/absolute/path', 8)).toBe(
      '  - /a/very/long/absolute/path',
    );
  });

  it('treats a hyphen with no following item as ordinary text', () => {
    expect(wrap('alpha - beta', 40)).toBe('alpha - beta');
  });
});
