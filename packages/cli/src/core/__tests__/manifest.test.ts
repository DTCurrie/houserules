import { describe, expect, it } from 'vitest';

import type { PluginSource } from '../../plugin-registry.js';
import type { HouseManifest } from '@houserules/api/internal';

const PLUGIN: PluginSource = {
  name: '@acme/kit-plugin',
  alias: 'acme',
  version: '1.2.0',
  dir: '/repo/node_modules/@acme/kit-plugin',
};

describe('HouseManifest, plugins field', () => {
  it('round-trips a recorded plugin through JSON', () => {
    const manifest: HouseManifest = {
      kitVersion: '1.0.0',
      installedAt: '2026-01-01T00:00:00.000Z',
      modules: ['core'],
      files: {},
      plugins: [PLUGIN],
    };

    const parsed = JSON.parse(JSON.stringify(manifest)) as HouseManifest;

    expect(parsed.plugins).toEqual([PLUGIN]);
  });

  it('parses a legacy manifest with no plugins field', () => {
    const legacy: HouseManifest = {
      kitVersion: '1.0.0',
      installedAt: '2026-01-01T00:00:00.000Z',
      modules: ['core'],
      files: {},
    };

    const parsed = JSON.parse(JSON.stringify(legacy)) as HouseManifest;

    expect(parsed.plugins).toBeUndefined();
  });
});
