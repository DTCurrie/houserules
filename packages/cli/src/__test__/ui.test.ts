import { describe, expect, it } from 'vitest';

import { optionPromptMessage, wrap } from '../ui.js';

import type { ModuleDef } from '@houserules/api';
import type { RegisteredModule } from '../plugin-registry.js';

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
const plain = (value: string) => value.replace(ANSI, '');

function registered(id: string, alias: string | null): RegisteredModule {
  const def: ModuleDef = {
    id,
    title: `${id} title`,
    group: 'optional',
    hint: () => id,
    defaultEnabled: () => true,
    plan: () => [],
  };
  if (alias === null) return { id, def, source: null };
  return {
    id: `${alias}/${id}`,
    def,
    source: {
      name: `@houserules/plugin-${alias}`,
      alias,
      version: '1.0.0',
      dir: '/x',
    },
  };
}

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

describe('optionPromptMessage', () => {
  it('names the module and its plugin ahead of the question', () => {
    const message = optionPromptMessage(
      registered('chrome-devtools-mcp', 'design'),
      'Install the slim variant?',
    );

    expect(plain(message)).toBe(
      'chrome-devtools-mcp [design]  Install the slim variant?',
    );
  });

  it('names a built-in module with no plugin tag', () => {
    const message = optionPromptMessage(
      registered('code-cleanliness', null),
      'Which guides?',
    );

    expect(plain(message)).toBe('code-cleanliness  Which guides?');
  });
});
