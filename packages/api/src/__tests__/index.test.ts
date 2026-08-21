import { describe, expect, it } from 'vitest';

import { definePlugin, type Plugin } from '../index.js';

describe('definePlugin', () => {
  it('returns the same function it was given', () => {
    const plugin: Plugin = () => [];
    expect(definePlugin(plugin)).toBe(plugin);
  });
});
