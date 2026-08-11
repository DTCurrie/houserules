import { describe, expect, it } from 'vitest';

import { KitConfigError, parseKitConfig } from '../config.js';

const minimalConfig = {
  version: 2,
  packageManager: 'pnpm',
  targets: [],
};

describe('parseKitConfig', () => {
  it('accepts a minimal valid config', () => {
    expect(parseKitConfig(JSON.stringify(minimalConfig))).toEqual(
      minimalConfig,
    );
  });

  it('rejects an unknown top-level key', () => {
    const raw = JSON.stringify({ ...minimalConfig, notAField: true });
    expect(() => parseKitConfig(raw)).toThrow(KitConfigError);
  });

  it('rejects a missing required field', () => {
    const raw = JSON.stringify({ version: 2, targets: [] });
    try {
      parseKitConfig(raw);
      throw new Error('expected parseKitConfig to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(KitConfigError);
      expect((error as KitConfigError).problems).toContain(
        'packageManager is required',
      );
    }
  });
});
