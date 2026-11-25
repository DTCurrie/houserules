import { describe, expect, it } from 'vitest';

import { passPathsDefault, takesPaths } from '../path-taking-scripts.js';
import { makeCtx, makeTarget } from '#test/ctx-builder';

describe('takesPaths', () => {
  it.each([
    ['eslint --fix'],
    ['prettier --cache --write'],
    ['eslint --fix --concurrency auto'],
    ['prettier --write --log-level warn'],
    ['eslint --fix --cache-location=.cache/eslint'],
    ['eslint -c eslint.config.mjs --fix'],
  ])('is true for %s', (script) => {
    expect(takesPaths(script)).toBe(true);
  });

  it.each([
    ['eslint . --fix'],
    ['prettier --cache --write .'],
    ['prettier --write .'],
    ['eslint . --fix --concurrency auto'],
    ['prettier . --write'],
    ['eslint --fix .'],
    ['eslint --fix src'],
    ['prettier -c src'],
    [
      'prettier --write . && ./etc/eslint-progress.sh . --fix --concurrency auto',
    ],
    ['wireit'],
    ['pnpm -r run --if-present lint:fix'],
    ['npx eslint --fix'],
    ["eslint --fix 'src/**/*.ts'"],
    [''],
    [undefined],
  ])('is false for %s', (script) => {
    expect(takesPaths(script)).toBe(false);
  });
});

describe('passPathsDefault', () => {
  const monorepoCtx = makeCtx({
    isMonorepo: true,
    rootPkg: {
      name: 'root',
      scripts: { 'lint:fix': 'eslint . --fix', format: 'prettier --write .' },
    },
    packages: [
      {
        name: 'a',
        dir: '/repo/packages/a',
        relDir: 'packages/a',
        pkg: {
          name: 'a',
          scripts: { 'lint:fix': 'eslint --fix', format: 'prettier --write' },
        },
      },
    ],
  });
  const monorepoTargets = [
    makeTarget({
      pathPrefix: 'packages/a/',
      fixCommands: ['lint:fix', 'format'],
    }),
  ];

  it('is on for a single-package set that all takes paths', () => {
    const ctx = makeCtx({
      rootPkg: {
        name: 'x',
        scripts: { 'lint:fix': 'eslint --fix', format: 'prettier --write' },
      },
    });
    const targets = [makeTarget({ fixCommands: ['lint:fix', 'format'] })];
    expect(
      passPathsDefault(ctx, targets, { runner: 'pnpm', filterFlag: '' }),
    ).toEqual({
      isOn: true,
      rejectedScripts: [],
    });
  });

  it('reads each target own scripts under a filter flag', () => {
    expect(
      passPathsDefault(monorepoCtx, monorepoTargets, {
        filterFlag: '--filter',
      }),
    ).toEqual({
      isOn: true,
      rejectedScripts: [],
    });
  });

  it('reads the root scripts when the filter flag is empty', () => {
    expect(
      passPathsDefault(monorepoCtx, monorepoTargets, { filterFlag: '' }),
    ).toEqual({
      isOn: false,
      rejectedScripts: ['lint:fix', 'format'],
    });
  });

  it('is off for a root target running eslint . --fix --concurrency auto and prettier --write .', () => {
    const ctx = makeCtx({
      rootPkg: {
        name: 'x',
        scripts: {
          'lint:fix': 'eslint . --fix --concurrency auto',
          'format:fix': 'prettier --write .',
        },
      },
    });
    const targets = [makeTarget({ fixCommands: ['lint:fix', 'format:fix'] })];
    expect(passPathsDefault(ctx, targets, { filterFlag: '' })).toEqual({
      isOn: false,
      rejectedScripts: ['lint:fix', 'format:fix'],
    });
  });

  it('is off for a workspace package whose own scripts target the whole tree', () => {
    const ctx = makeCtx({
      isMonorepo: true,
      rootPkg: {
        name: 'root',
        scripts: { 'lint:fix': 'pnpm -r run --if-present lint:fix' },
      },
      packages: [
        {
          name: 'a',
          dir: '/repo/packages/a',
          relDir: 'packages/a',
          pkg: {
            name: 'a',
            scripts: {
              'lint:fix': 'eslint . --fix',
              'format:fix': 'prettier --write .',
            },
          },
        },
      ],
    });
    const targets = [
      makeTarget({
        pathPrefix: 'packages/a/',
        fixCommands: ['lint:fix', 'format:fix'],
      }),
    ];
    expect(passPathsDefault(ctx, targets, { filterFlag: '--filter' })).toEqual({
      isOn: false,
      rejectedScripts: ['lint:fix', 'format:fix'],
    });
  });

  it('is off for a mixed set and names the whole-tree script', () => {
    const ctx = makeCtx({
      rootPkg: {
        name: 'x',
        scripts: { 'lint:fix': 'eslint --fix', format: 'prettier --write .' },
      },
    });
    const targets = [makeTarget({ fixCommands: ['lint:fix', 'format'] })];
    expect(passPathsDefault(ctx, targets, { filterFlag: '' })).toEqual({
      isOn: false,
      rejectedScripts: ['format'],
    });
  });

  it('is off with no rejected scripts for a set with no fix commands', () => {
    const targets = [makeTarget({ fixCommands: [] })];
    expect(passPathsDefault(makeCtx(), targets, { filterFlag: '' })).toEqual({
      isOn: false,
      rejectedScripts: [],
    });
  });

  it('rejects a named script the package.json does not hold', () => {
    const ctx = makeCtx({
      rootPkg: { name: 'x', scripts: { 'lint:fix': 'eslint --fix' } },
    });
    const targets = [makeTarget({ fixCommands: ['lint:fix', 'format'] })];
    expect(passPathsDefault(ctx, targets, { filterFlag: '' })).toEqual({
      isOn: false,
      rejectedScripts: ['format'],
    });
  });
});
