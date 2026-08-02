import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

import {
  buildJsonSchema,
  KitConfigError,
  parseKitConfig,
  validateKitConfig,
} from '../src/core/config.js';
import { makeFixture, runCli } from './fixtures.js';
import { rmSync } from 'node:fs';
import { join } from 'node:path';

function repoFile(relativePath: string): string {
  return readFileSync(
    fileURLToPath(new URL(relativePath, import.meta.url)),
    'utf8',
  );
}

test('CS1: the committed JSON Schema is in sync with the zod schema', () => {
  const committed: unknown = JSON.parse(
    repoFile('../schema/kit.config.schema.json'),
  );
  expect(committed, 'stale — run `pnpm run schema`').toEqual(buildJsonSchema());
});

test('CS2: the root is closed to unknown keys', () => {
  expect(buildJsonSchema().additionalProperties).toBe(false);
});

test('CS3: the shipped example config parses', () => {
  // The example is what we tell people to copy (including its `_help`/`_notes`
  // documentation keys), which a strict schema must therefore accept.
  expect(() =>
    parseKitConfig(repoFile('../kit.config.example.json')),
  ).not.toThrow();
});

test('CS4: the config init actually generates parses, for every fixture shape', () => {
  for (const kind of [
    'pnpm-monorepo',
    'pnpm-flow-monorepo',
    'npm-single',
    'non-js',
  ] as const) {
    const root = makeFixture(kind);
    try {
      expect(runCli(['init', '--yes', root]).status).toBe(0);
      const raw = readFileSync(join(root, '.claude/kit.config.json'), 'utf8');
      expect(
        validateKitConfig(raw),
        `${kind}: generated config must satisfy its own schema`,
      ).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('CS5: a misspelled key is reported by name, not swallowed', () => {
  const raw = JSON.stringify({
    version: 2,
    packageManager: 'pnpm',
    targets: [],
    changesets: { enabled: true, baseBranchh: 'main' },
  });
  const problems = validateKitConfig(raw);
  expect(problems).toContain(
    'changesets.baseBranchh is not a known changesets setting',
  );
});

test('CS6: a wrong-typed field names the path', () => {
  const raw = JSON.stringify({
    version: 2,
    packageManager: 'pnpm',
    targets: [],
    changesets: { stopCheck: 'no' },
  });
  const problems = validateKitConfig(raw);
  expect(problems.some((p) => p.startsWith('changesets.stopCheck'))).toBe(true);
});

test('CS7: a missing required field says so; invalid JSON is reported as such', () => {
  expect(validateKitConfig(JSON.stringify({ packageManager: 'pnpm' }))).toEqual(
    expect.arrayContaining([expect.stringContaining('version')]),
  );
  expect(validateKitConfig('{ not json')).toEqual([
    expect.stringContaining('not valid JSON'),
  ]);
});

test('CS8: parseKitConfig throws KitConfigError carrying every problem', () => {
  try {
    parseKitConfig(JSON.stringify({ version: 2, targets: [], nope: 1 }));
    expect.unreachable('should have thrown');
  } catch (error) {
    expect(error).toBeInstanceOf(KitConfigError);
    expect((error as KitConfigError).problems.length).toBeGreaterThan(0);
  }
});
