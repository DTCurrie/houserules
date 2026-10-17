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

  it('accepts design.themeEntry as a top-level design key', () => {
    const config = {
      ...minimalConfig,
      design: { themeEntry: 'packages/ui/src/app.css' },
    };
    expect(parseHouseConfig(JSON.stringify(config))).toEqual(config);
  });

  it('rejects a misspelled key inside design', () => {
    const raw = JSON.stringify({
      ...minimalConfig,
      design: { themeEntri: 'packages/ui/src/app.css' },
    });
    expect(() => parseHouseConfig(raw)).toThrow(HouseConfigError);
  });

  it('accepts orchestrate.workerTools as a list of tool names', () => {
    const config = {
      ...minimalConfig,
      orchestrate: { workerTools: ['mcp__svelte__svelte-autofixer'] },
    };
    expect(parseHouseConfig(JSON.stringify(config))).toEqual(config);
  });

  it('accepts orchestrate.workerTools server patterns', () => {
    const config = {
      ...minimalConfig,
      orchestrate: { workerTools: ['mcp__x', 'mcp__y__*'] },
    };
    expect(parseHouseConfig(JSON.stringify(config))).toEqual(config);
  });

  it('rejects a misspelled key inside orchestrate', () => {
    const raw = JSON.stringify({
      ...minimalConfig,
      orchestrate: { workerTool: ['mcp__svelte__svelte-autofixer'] },
    });
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

  describe('verify.timeoutMs', () => {
    const runner = {
      runner: 'pnpm',
      filterFlag: '--filter',
      runScriptPrefix: ['run'],
      commands: ['check'],
    };

    it('accepts a positive integer', () => {
      const config = {
        ...minimalConfig,
        verify: { ...runner, timeoutMs: 600000 },
      };
      expect(parseHouseConfig(JSON.stringify(config))).toEqual(config);
    });

    it.each([0, -1, 1.5])('rejects %s', (timeoutMs) => {
      const raw = JSON.stringify({
        ...minimalConfig,
        verify: { ...runner, timeoutMs },
      });
      expect(() => parseHouseConfig(raw)).toThrow(HouseConfigError);
    });

    it('rejects timeoutMs on the fix block', () => {
      const raw = JSON.stringify({
        ...minimalConfig,
        fix: { ...runner, timeoutMs: 1000 },
      });
      expect(() => parseHouseConfig(raw)).toThrow(HouseConfigError);
    });
  });
});
