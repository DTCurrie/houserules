import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  buildJsonSchema,
  HouseConfigError,
  parseHouseConfig,
  validateHouseConfig,
} from '@houserules/api/internal';

function repoFile(relativePath: string): string {
  return readFileSync(
    fileURLToPath(new URL(relativePath, import.meta.url)),
    'utf8',
  );
}

const minimalConfig = {
  version: 2,
  packageManager: 'pnpm',
  targets: [],
};

describe('buildJsonSchema', () => {
  it('matches the committed JSON Schema', () => {
    const committed: unknown = JSON.parse(
      repoFile('../../../schema/houserules.config.schema.json'),
    );
    expect(committed, 'stale — run `pnpm run schema`').toEqual(
      buildJsonSchema(),
    );
  });

  it('closes the root object to unknown keys', () => {
    expect(buildJsonSchema().additionalProperties).toBe(false);
  });
});

describe('parseHouseConfig', () => {
  it('parses a minimal valid config', () => {
    expect(parseHouseConfig(JSON.stringify(minimalConfig))).toEqual(
      minimalConfig,
    );
  });

  it('parses the shipped example config', () => {
    expect(() =>
      parseHouseConfig(repoFile('../../../houserules.config.example.json')),
    ).not.toThrow();
  });

  it('throws on JSON that does not parse', () => {
    expect(() => parseHouseConfig('{ not json')).toThrow(/not valid JSON/);
  });

  it('names version as the problem when it is missing, since a literal field never reports "is required"', () => {
    const raw = JSON.stringify({ packageManager: 'pnpm', targets: [] });
    try {
      parseHouseConfig(raw);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(
        (error as HouseConfigError).problems.some((p) =>
          p.startsWith('version'),
        ),
      ).toBe(true);
    }
  });

  it.each([1, 3])(
    'rejects version %d, since only 2 is a known schema version',
    (version) => {
      const raw = JSON.stringify({ ...minimalConfig, version });
      try {
        parseHouseConfig(raw);
        expect.unreachable('should have thrown');
      } catch (error) {
        expect(
          (error as HouseConfigError).problems.some((p) =>
            p.startsWith('version'),
          ),
        ).toBe(true);
      }
    },
  );

  it('names packageManager as required when it is missing', () => {
    const raw = JSON.stringify({ version: 2, targets: [] });
    try {
      parseHouseConfig(raw);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as HouseConfigError).problems).toContain(
        'packageManager is required',
      );
    }
  });

  it('names packageManager as the problem when it is a number instead of a string', () => {
    const raw = JSON.stringify({ ...minimalConfig, packageManager: 5 });
    try {
      parseHouseConfig(raw);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(
        (error as HouseConfigError).problems.some((p) =>
          p.startsWith('packageManager'),
        ),
      ).toBe(true);
    }
  });

  it('names lintableExtensions as the problem when it is a string instead of an array', () => {
    const raw = JSON.stringify({
      ...minimalConfig,
      lintableExtensions: 'ts,tsx',
    });
    try {
      parseHouseConfig(raw);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(
        (error as HouseConfigError).problems.some((p) =>
          p.startsWith('lintableExtensions'),
        ),
      ).toBe(true);
    }
  });

  it('rejects an empty packageManager, since the field requires at least one character', () => {
    const raw = JSON.stringify({ ...minimalConfig, packageManager: '' });
    try {
      parseHouseConfig(raw);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(
        (error as HouseConfigError).problems.some((p) =>
          p.startsWith('packageManager'),
        ),
      ).toBe(true);
    }
  });

  it('names an unrecognized root key by name', () => {
    const raw = JSON.stringify({ ...minimalConfig, bogus: true });
    try {
      parseHouseConfig(raw);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as HouseConfigError).problems).toContain(
        'bogus is not a known field',
      );
    }
  });

  it.each([
    ['guard', 'guard switch'],
    ['readGuard', 'read-guard setting'],
    ['scripts', 'scripts setting'],
  ])('names an unrecognized key inside %s as a %s', (section, noun) => {
    const raw = JSON.stringify({
      ...minimalConfig,
      [section]: { bogus: true },
    });
    try {
      parseHouseConfig(raw);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as HouseConfigError).problems).toContain(
        `${section}.bogus is not a known ${noun}`,
      );
    }
  });

  it('names an unrecognized key inside a nested block without a dedicated noun as "field"', () => {
    const raw = JSON.stringify({
      ...minimalConfig,
      fix: {
        runner: 'pnpm',
        filterFlag: '',
        runScriptPrefix: [],
        commands: [],
        bogus: true,
      },
    });
    try {
      parseHouseConfig(raw);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as HouseConfigError).problems).toContain(
        'fix.bogus is not a known field',
      );
    }
  });

  it('names fix.onSubagentStop as the problem when it is not a boolean', () => {
    const raw = JSON.stringify({
      ...minimalConfig,
      fix: {
        runner: 'pnpm',
        filterFlag: '',
        runScriptPrefix: [],
        commands: [],
        onSubagentStop: 'yes',
      },
    });
    try {
      parseHouseConfig(raw);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(
        (error as HouseConfigError).problems.some((p) =>
          p.startsWith('fix.onSubagentStop'),
        ),
      ).toBe(true);
    }
  });

  it('names a missing required field inside a target by its indexed path', () => {
    const raw = JSON.stringify({
      version: 2,
      packageManager: 'pnpm',
      targets: [{ name: 'core', prefix: 'CORE', label: 'Core' }],
    });
    try {
      parseHouseConfig(raw);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(
        (error as HouseConfigError).problems.some((p) =>
          p.startsWith('targets.0.packageName'),
        ),
      ).toBe(true);
    }
  });
});

describe('HouseConfigError', () => {
  it('carries one problem entry per validation failure', () => {
    const raw = JSON.stringify({
      version: 1,
      targets: [],
      bogus: true,
    });
    try {
      parseHouseConfig(raw);
      expect.unreachable('should have thrown');
    } catch (error) {
      const problems = (error as HouseConfigError).problems;
      expect(problems.length).toBeGreaterThanOrEqual(3);
    }
  });

  it('renders every problem as a bullet in the error message', () => {
    const error = new HouseConfigError(['a is wrong', 'b is wrong']);
    expect(error.message).toContain('  - a is wrong');
    expect(error.message).toContain('  - b is wrong');
  });
});

describe('validateHouseConfig', () => {
  it('returns an empty array for a valid config', () => {
    expect(validateHouseConfig(JSON.stringify(minimalConfig))).toEqual([]);
  });

  it('returns problems instead of throwing for an invalid config', () => {
    expect(() =>
      validateHouseConfig(JSON.stringify({ packageManager: 'pnpm' })),
    ).not.toThrow();
  });

  it('reports a missing required field by name', () => {
    expect(
      validateHouseConfig(JSON.stringify({ packageManager: 'pnpm' })),
    ).toEqual(expect.arrayContaining([expect.stringContaining('version')]));
  });

  it('reports a misspelled key inside changesets by name, using the changesets noun', () => {
    const raw = JSON.stringify({
      ...minimalConfig,
      changesets: { enabled: true, baseBranchh: 'main' },
    });
    expect(validateHouseConfig(raw)).toContain(
      'changesets.baseBranchh is not a known changesets setting',
    );
  });
});
