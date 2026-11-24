import { describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import { linkInstalledChangesetsCli } from '#test/changesets-cli';
import { useRepo } from '#test/repo';
import { createGatedOwnerResolver } from '../changeset-owner.mjs';

const INSTALLED_CHANGESETS_CLI = dirname(
  createRequire(import.meta.url).resolve('@changesets/cli/package.json'),
);

const INSTALLED_MICROMATCH = dirname(
  createRequire(import.meta.url).resolve('micromatch/package.json'),
);

const PACKAGES = [
  { name: '@fix/cityville', relDir: 'games/cityville' },
  { name: '@fix/studio', relDir: 'apps/studio' },
];

function workspacePackages(root: string) {
  return PACKAGES.map(({ name, relDir }) => ({
    name,
    dir: join(root, relDir),
    relDir,
    pkg: {},
  }));
}

function publishManifest(
  root: string,
  relDir: string,
  fields: Record<string, unknown>,
): void {
  const manifestPath = join(root, relDir, 'package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<
    string,
    unknown
  >;
  Object.assign(manifest, { private: false }, fields);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

function publishableCityvilleResolver(
  fields: Record<string, unknown>,
  gateIgnore: string[],
): (path: string) => string | null {
  const root = useRepo('pnpm-monorepo');
  publishManifest(root, 'games/cityville', fields);
  return createGatedOwnerResolver(
    root,
    workspacePackages(root).slice(0, 1),
    gateIgnore,
  );
}

function writeChangesetsIgnore(root: string, ignore: string[]): void {
  mkdirSync(join(root, '.changeset'), { recursive: true });
  writeFileSync(
    join(root, '.changeset/config.json'),
    JSON.stringify({ ignore }),
  );
}

function installChangesetsConfigV3(root: string): void {
  const configDir = join(root, 'node_modules/@changesets/config');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, 'package.json'),
    JSON.stringify({
      name: '@changesets/config',
      version: '3.1.4',
      dependencies: { micromatch: '^4.0.8' },
    }),
  );
  symlinkSync(
    INSTALLED_MICROMATCH,
    join(root, 'node_modules/micromatch'),
    'dir',
  );
}

function ignoredPackagesFor(
  ignore: string[],
  installChangesets: (root: string) => void = (root) =>
    linkInstalledChangesetsCli(root, INSTALLED_CHANGESETS_CLI),
): string[] {
  const root = useRepo('pnpm-monorepo');
  for (const { relDir } of PACKAGES) publishManifest(root, relDir, {});
  writeChangesetsIgnore(root, ignore);
  installChangesets(root);
  const resolveOwner = createGatedOwnerResolver(
    root,
    workspacePackages(root),
    [],
  );
  return PACKAGES.filter(
    ({ relDir }) => resolveOwner(`${relDir}/src/index.ts`) === null,
  ).map(({ name }) => name);
}

describe('createGatedOwnerResolver', () => {
  it.each([
    {
      files: ['dist'],
      path: 'games/cityville/test/fixture.ts',
      owner: null,
    },
    {
      files: ['dist'],
      path: 'games/cityville/tests/fixture.ts',
      owner: null,
    },
    {
      files: ['dist'],
      path: 'games/cityville/src/game.ts',
      owner: '@fix/cityville',
    },
    {
      files: ['dist'],
      path: 'games/cityville/src/test/helper.ts',
      owner: '@fix/cityville',
    },
    {
      files: ['dist', 'test'],
      path: 'games/cityville/test/fixture.ts',
      owner: '@fix/cityville',
    },
    {
      files: ['dist', './test/fixtures/'],
      path: 'games/cityville/test/fixtures/world.ts',
      owner: '@fix/cityville',
    },
    {
      files: undefined,
      path: 'games/cityville/test/fixture.ts',
      owner: '@fix/cityville',
    },
  ])(
    'resolves $path to $owner when the files list is $files',
    ({ files, path, owner }) => {
      const resolveOwner = publishableCityvilleResolver({ files }, []);

      expect(resolveOwner(path)).toBe(owner);
    },
  );

  it('resolves a path matching a gateIgnore glob to no owner', () => {
    const resolveOwner = publishableCityvilleResolver({ files: ['dist'] }, [
      'games/cityville/src/**',
    ]);

    expect(resolveOwner('games/cityville/src/game.ts')).toBe(null);
  });
});

describe('createGatedOwnerResolver, root files npm packs regardless of files', () => {
  it.each([
    { entry: 'main', fields: { main: './cli.js' } },
    { entry: 'a string bin', fields: { bin: 'cli.js' } },
    { entry: 'an object bin', fields: { bin: { fix: './cli.js' } } },
  ])(
    'owes a changeset for a root file the manifest names as $entry',
    ({ fields }) => {
      const resolveOwner = publishableCityvilleResolver(
        { files: ['dist'], ...fields },
        [],
      );

      expect(resolveOwner('games/cityville/cli.js')).toBe('@fix/cityville');
    },
  );

  it('owes none for a root file neither files, main, nor bin names', () => {
    const resolveOwner = publishableCityvilleResolver(
      { files: ['dist'], main: './cli.js', bin: { fix: './cli.js' } },
      [],
    );

    expect(resolveOwner('games/cityville/eslint.config.js')).toBe(null);
  });
});

describe('createGatedOwnerResolver, the changesets ignore list', () => {
  it.each([
    { entry: '@fix/{cityville,other}', ignored: ['@fix/cityville'] },
    { entry: '@fix/!(cityville)', ignored: ['@fix/studio'] },
    { entry: '@fix/@(studio|other)', ignored: ['@fix/studio'] },
  ])('ignores exactly $ignored for the entry $entry', ({ entry, ignored }) => {
    expect(ignoredPackagesFor([entry])).toEqual(ignored);
  });

  it.each([
    { entry: '@fix/{cityville,other}', ignored: ['@fix/cityville'] },
    { entry: '@fix/!(cityville)', ignored: ['@fix/studio'] },
    { entry: '!@fix/studio', ignored: ['@fix/cityville'] },
  ])(
    'ignores exactly $ignored for the entry $entry under @changesets/config 3.x, which uses micromatch',
    ({ entry, ignored }) => {
      expect(
        ignoredPackagesFor([entry], installChangesetsConfigV3),
        'a lone negated entry matches nothing under the 4.x picomatch filter, so [] here means the picomatch branch ran',
      ).toEqual(ignored);
    },
  );

  it('resolves nothing and throws nothing when the ignore list is empty', () => {
    const root = useRepo('pnpm-monorepo');
    publishManifest(root, 'games/cityville', {});
    writeChangesetsIgnore(root, []);

    const resolveOwner = createGatedOwnerResolver(
      root,
      workspacePackages(root),
      [],
    );

    expect(resolveOwner('games/cityville/src/game.ts')).toBe('@fix/cityville');
  });
});
