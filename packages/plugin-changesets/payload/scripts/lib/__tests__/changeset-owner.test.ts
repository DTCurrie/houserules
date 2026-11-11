import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { useRepo } from '#test/repo';
import { createGatedOwnerResolver } from '../changeset-owner.mjs';

function publishableCityvilleResolver(
  files: string[] | undefined,
  gateIgnore: string[],
): (path: string) => string | null {
  const root = useRepo('pnpm-monorepo');
  const manifestPath = join(root, 'games/cityville/package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<
    string,
    unknown
  >;
  manifest.private = false;
  manifest.files = files;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return createGatedOwnerResolver(
    root,
    [
      {
        name: '@fix/cityville',
        dir: join(root, 'games/cityville'),
        relDir: 'games/cityville',
        pkg: {},
      },
    ],
    gateIgnore,
  );
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
      const resolveOwner = publishableCityvilleResolver(files, []);

      expect(resolveOwner(path)).toBe(owner);
    },
  );

  it('resolves a path matching a gateIgnore glob to no owner', () => {
    const resolveOwner = publishableCityvilleResolver(
      ['dist'],
      ['games/cityville/src/**'],
    );

    expect(resolveOwner('games/cityville/src/game.ts')).toBe(null);
  });
});
