import { describe, expect, it } from 'vitest';

import { HouseConfigError, parseHouseConfig } from '../config.js';

const minimalConfig = {
  version: 2,
  packageManager: 'pnpm',
  targets: [],
};

describe('parseHouseConfig', () => {
  it('accepts a minimal valid config', () => {
    expect(parseHouseConfig(JSON.stringify(minimalConfig))).toEqual(
      minimalConfig,
    );
  });

  it('rejects an unknown top-level key', () => {
    const raw = JSON.stringify({ ...minimalConfig, notAField: true });
    expect(() => parseHouseConfig(raw)).toThrow(HouseConfigError);
  });

  it('rejects a missing required field', () => {
    const raw = JSON.stringify({ version: 2, targets: [] });
    try {
      parseHouseConfig(raw);
      throw new Error('expected parseHouseConfig to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(HouseConfigError);
      expect((error as HouseConfigError).problems).toContain(
        'packageManager is required',
      );
    }
  });
});
