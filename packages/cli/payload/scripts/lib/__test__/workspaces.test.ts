import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  listWorkspacePackages,
  parsePnpmWorkspaceGlobs,
} from '../../../../payload-dist/scripts/lib/workspaces.mjs';

describe('parsePnpmWorkspaceGlobs', () => {
  it.each([
    {
      name: 'block sequence',
      yaml: 'packages:\n  - packages/*\n  - apps/*\n',
      expected: ['packages/*', 'apps/*'],
    },
    {
      name: 'flow sequence quoted',
      yaml: 'packages: ["packages/*", "apps/*"]\n',
      expected: ['packages/*', 'apps/*'],
    },
    {
      name: 'flow sequence bare',
      yaml: 'packages: [packages/*, apps/*]\n',
      expected: ['packages/*', 'apps/*'],
    },
    {
      name: 'flow sequence multiline',
      yaml: 'packages: [\n  packages/*,\n  apps/*\n]\n',
      expected: ['packages/*', 'apps/*'],
    },
    { name: 'flow sequence empty', yaml: 'packages: []\n', expected: [] },
    {
      name: 'single-quoted items',
      yaml: 'packages:\n  - \'packages/*\'\n  - "apps/*"\n',
      expected: ['packages/*', 'apps/*'],
    },
    {
      name: 'inline comments stripped',
      yaml: 'packages:\n  - packages/*  # the libs\n  - apps/*\n',
      expected: ['packages/*', 'apps/*'],
    },
    {
      name: 'comment lines skipped',
      yaml: 'packages:\n  # libs\n  - packages/*\n',
      expected: ['packages/*'],
    },
    {
      name: 'negations pass through',
      yaml: 'packages:\n  - packages/*\n  - "!packages/legacy"\n',
      expected: ['packages/*', '!packages/legacy'],
    },
    {
      name: 'sibling catalog block after',
      yaml: 'packages:\n  - packages/*\n\ncatalog:\n  typescript: 6.0.3\n',
      expected: ['packages/*'],
    },
    {
      name: 'sibling catalog block before',
      yaml: 'catalog:\n  typescript: 6.0.3\npackages:\n  - packages/*\n',
      expected: ['packages/*'],
    },
    {
      name: 'nested packages: key under catalogs is a version pin for a package named "packages", not our key',
      yaml: 'catalogs:\n  ui:\n    packages: 1.0.0\npackages:\n  - apps/*\n',
      expected: ['apps/*'],
    },
    {
      name: 'multi-document marker',
      yaml: '---\npackages:\n  - packages/*\n',
      expected: ['packages/*'],
    },
    {
      name: 'CRLF line endings',
      yaml: 'packages:\r\n  - packages/*\r\n  - apps/*\r\n',
      expected: ['packages/*', 'apps/*'],
    },
    { name: 'no packages key', yaml: 'catalogMode: strict\n', expected: [] },
    {
      name: 'globstar is passed through verbatim',
      yaml: 'packages:\n  - packages/**\n',
      expected: ['packages/**'],
    },
    {
      // Tabs are illegal YAML indentation and a strict parser would reject this file,
      // but this parser tolerates it since a hook must never crash on a malformed file.
      name: 'tab indentation accepted leniently',
      yaml: 'packages:\n\t- packages/*\n',
      expected: ['packages/*'],
    },
  ])('extracts $expected from $name', ({ yaml, expected }) => {
    expect(parsePnpmWorkspaceGlobs(yaml)).toEqual(expected);
  });

  it.each(['', 'packages:', 'packages: [', '  ', 'packages:\n  - \n'])(
    'never throws on malformed input %j',
    (junk) => {
      expect(() => parsePnpmWorkspaceGlobs(junk)).not.toThrow();
    },
  );

  it('extracts a quoted flow sequence rather than degrading the monorepo to a single package', () => {
    expect(
      parsePnpmWorkspaceGlobs('packages: ["packages/*", "apps/*"]'),
    ).toEqual(['packages/*', 'apps/*']);
  });
});

function makeWorkspaceTree(): string {
  const root = mkdtempSync(join(tmpdir(), 'kit-glob-'));
  const dirs = [
    'packages/a',
    'packages/b',
    'packages/legacy',
    'packages/group/deep',
    'apps/web',
    'solo',
    'packages/a/node_modules/dep',
  ];
  for (const dir of dirs) {
    mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(
      join(root, dir, 'package.json'),
      JSON.stringify({ name: `@x/${dir.replaceAll('/', '-')}` }),
    );
  }
  mkdirSync(join(root, 'packages/empty'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'root' }));
  return root;
}

function packageDirsFor(root: string, globs: string[]): string[] {
  writeFileSync(
    join(root, 'pnpm-workspace.yaml'),
    `packages:\n${globs.map((g) => `  - ${JSON.stringify(g)}`).join('\n')}\n`,
  );
  return listWorkspacePackages(root)
    .map((p) => p.relDir)
    .sort();
}

describe('listWorkspacePackages', () => {
  it.each([
    {
      name: 'single star matches one level',
      globs: ['packages/*'],
      expected: ['packages/a', 'packages/b', 'packages/legacy'],
    },
    {
      name: 'two globs union',
      globs: ['packages/*', 'apps/*'],
      expected: ['apps/web', 'packages/a', 'packages/b', 'packages/legacy'],
    },
    {
      name: 'globstar recurses to any depth',
      globs: ['packages/**'],
      expected: [
        'packages/a',
        'packages/b',
        'packages/group/deep',
        'packages/legacy',
      ],
    },
    { name: 'literal directory', globs: ['solo'], expected: ['solo'] },
    {
      name: 'deep literal directory',
      globs: ['packages/group/deep'],
      expected: ['packages/group/deep'],
    },
    {
      name: 'trailing slash tolerated',
      globs: ['packages/*/'],
      expected: ['packages/a', 'packages/b', 'packages/legacy'],
    },
    {
      name: 'negation excludes a matched entry',
      globs: ['packages/*', '!packages/legacy'],
      expected: ['packages/a', 'packages/b'],
    },
    {
      name: 'negation under globstar',
      globs: ['packages/**', '!packages/legacy'],
      expected: ['packages/a', 'packages/b', 'packages/group/deep'],
    },
    {
      name: 'negation excludes a whole subtree',
      globs: ['packages/**', '!packages/group'],
      expected: ['packages/a', 'packages/b', 'packages/legacy'],
    },
    {
      name: 'nonexistent glob yields nothing',
      globs: ['ghost/*'],
      expected: [],
    },
    {
      name: 'scaffold dirs without package.json and node_modules are both excluded',
      globs: ['packages/**', 'apps/*'],
      expected: [
        'apps/web',
        'packages/a',
        'packages/b',
        'packages/group/deep',
        'packages/legacy',
      ],
    },
  ])('resolves $globs to $expected for $name', ({ globs, expected }) => {
    const root = makeWorkspaceTree();
    try {
      expect(packageDirsFor(root, globs)).toEqual(expected);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('recurses a globstar to any depth and applies negation, rather than degrading ** to * and ignoring !', () => {
    const root = makeWorkspaceTree();
    try {
      expect(packageDirsFor(root, ['packages/**', '!packages/legacy'])).toEqual(
        ['packages/a', 'packages/b', 'packages/group/deep'],
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
