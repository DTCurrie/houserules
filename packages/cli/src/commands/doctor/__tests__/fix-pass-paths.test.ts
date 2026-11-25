import { describe, expect, it } from 'vitest';

import { makeCtx } from '#test/ctx-builder';
import type { HouseConfig } from '@houserules/api';
import type { HouseManifest } from '@houserules/api/internal';
import type { Ctx } from '../../../detect.js';
import { checkFixPassPaths } from '../fix-pass-paths.js';

type Fix = Partial<NonNullable<HouseConfig['fix']>>;
type Scripts = Record<string, string>;

const ROOT_TARGET = {
  name: 'solo',
  prefix: 'SOLO',
  packageName: 'solo',
  pathPrefix: '',
  sourcePath: 'src',
  label: 'Solo',
  fixCommands: ['lint:fix', 'format'],
};

function singlePackageCtx(
  scripts: Scripts,
  fix: Fix = {},
  modules: string[] = ['core', 'lint-fix'],
): Ctx {
  const base = makeCtx();
  return {
    ...base,
    rootPkg: { name: 'solo', scripts },
    claude: {
      ...base.claude,
      houseConfig: {
        version: 2,
        modules,
        fix: { filterFlag: '', ...fix },
        targets: [ROOT_TARGET],
      } as unknown as HouseConfig,
    },
  };
}

const PATH_TAKING: Scripts = {
  'lint:fix': 'eslint --fix',
  format: 'prettier --write',
};
const WHOLE_TREE: Scripts = {
  'lint:fix': 'eslint . --fix',
  format: 'prettier --write .',
};

function monorepoCtx(filterFlag: string): Ctx {
  const base = makeCtx();
  const target = (name: string) => ({
    name,
    prefix: name.toUpperCase(),
    packageName: name,
    pathPrefix: `packages/${name}/`,
    sourcePath: `packages/${name}/src`,
    label: name,
  });
  return {
    ...base,
    rootPkg: { name: 'mono', scripts: WHOLE_TREE },
    packages: ['a', 'b'].map((name) => ({
      name,
      dir: `/repo/packages/${name}`,
      relDir: `packages/${name}`,
      pkg: { name, scripts: PATH_TAKING },
    })),
    claude: {
      ...base.claude,
      houseConfig: {
        version: 2,
        modules: ['core', 'lint-fix'],
        fix: {
          filterFlag,
          passPaths: true,
          commands: ['lint:fix', 'format'],
        },
        targets: [target('a'), target('b')],
      } as unknown as HouseConfig,
    },
  };
}

describe('checkFixPassPaths', () => {
  it('warns that a Stop fixes nothing when the key is absent and every script takes paths', () => {
    const result = checkFixPassPaths(singlePackageCtx(PATH_TAKING));

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.level).toBe('WARN');
    expect(result.findings[0]?.msg).toContain('fix.passPaths');
    expect(result.findings[0]?.msg).toContain('`true`');
  });

  it('warns the same when the key is explicitly false', () => {
    const result = checkFixPassPaths(
      singlePackageCtx(PATH_TAKING, { passPaths: false }),
    );

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.level).toBe('WARN');
    expect(result.findings[0]?.msg).toContain('fix.passPaths');
  });

  it('warns with the rejected scripts and the exact change when the key is off and scripts target the tree', () => {
    const result = checkFixPassPaths(singlePackageCtx(WHOLE_TREE));

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.level).toBe('WARN');
    for (const token of [
      'fix.passPaths',
      '"lint:fix"',
      '"format"',
      'lint:fix:paths',
      'eslint --fix',
      'prettier --write',
      'fixCommands',
      'passPaths',
    ]) {
      expect(result.findings[0]?.msg).toContain(token);
    }
  });

  it('warns for a root target whose scripts are eslint . --fix --concurrency auto and prettier --write .', () => {
    const ctx = singlePackageCtx({
      'lint:fix': 'eslint . --fix --concurrency auto',
      'format:fix': 'prettier --write .',
    });
    const config = ctx.claude.houseConfig as unknown as {
      targets: Array<Record<string, unknown>>;
    };
    config.targets = [
      { ...ROOT_TARGET, fixCommands: ['lint:fix', 'format:fix'] },
    ];

    const result = checkFixPassPaths(ctx);

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.level).toBe('WARN');
    for (const token of [
      '"lint:fix"',
      '"format:fix"',
      'lint:fix:paths',
      'fixCommands',
      'passPaths',
    ]) {
      expect(result.findings[0]?.msg).toContain(token);
    }
  });

  it('warns for a workspace whose package scripts are whole-tree and whose root script is a pnpm fan-out', () => {
    const base = makeCtx();
    const ctx: Ctx = {
      ...base,
      rootPkg: {
        name: 'prime',
        scripts: { 'lint:fix': 'pnpm -r run --if-present lint:fix' },
      },
      packages: [
        {
          name: 'app',
          dir: '/repo/packages/app',
          relDir: 'packages/app',
          pkg: {
            name: 'app',
            scripts: {
              'lint:fix': 'eslint . --fix',
              'format:fix': 'prettier --write .',
            },
          },
        },
      ],
      claude: {
        ...base.claude,
        houseConfig: {
          version: 2,
          modules: ['core', 'lint-fix'],
          fix: {
            filterFlag: '--filter',
            commands: ['lint:fix', 'format:fix'],
          },
          targets: [
            {
              name: 'app',
              prefix: 'APP',
              packageName: 'app',
              pathPrefix: 'packages/app/',
              sourcePath: 'packages/app/src',
              label: 'App',
            },
          ],
        } as unknown as HouseConfig,
      },
    };

    const result = checkFixPassPaths(ctx);

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.level).toBe('WARN');
    for (const token of [
      '"lint:fix"',
      '"format:fix"',
      'lint:fix:paths',
      'fixCommands',
      'passPaths',
    ]) {
      expect(result.findings[0]?.msg).toContain(token);
    }
  });

  it('gives no finding when the only rejected script is undefined in package.json', () => {
    const result = checkFixPassPaths(
      singlePackageCtx({ 'lint:fix': 'eslint --fix' }),
    );

    expect(result.findings).toEqual([]);
  });

  it('gives no finding when the key is on and every script takes paths', () => {
    const result = checkFixPassPaths(
      singlePackageCtx(PATH_TAKING, { passPaths: true }),
    );

    expect(result.findings).toEqual([]);
  });

  it('names only the script that does not take paths when the key is on', () => {
    const result = checkFixPassPaths(
      singlePackageCtx(
        { 'lint:fix': 'eslint . --fix', format: 'prettier --write' },
        { passPaths: true },
      ),
    );

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.level).toBe('WARN');
    expect(result.findings[0]?.msg).toContain('"lint:fix"');
    expect(result.findings[0]?.msg).not.toContain('"format"');
  });

  it('gives no finding in a monorepo whose targets take paths under the package filter', () => {
    expect(checkFixPassPaths(monorepoCtx('--filter')).findings).toEqual([]);
  });

  it('names the root scripts in a monorepo when the runner drops the package filter', () => {
    const result = checkFixPassPaths(monorepoCtx(''));

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.msg).toContain('"lint:fix"');
    expect(result.findings[0]?.msg).toContain('"format"');
  });

  it('gives no finding when lint-fix is not installed', () => {
    const result = checkFixPassPaths(
      singlePackageCtx(WHOLE_TREE, { passPaths: true }, ['core']),
    );

    expect(result.findings).toEqual([]);
  });

  it('gives no finding when the config is null, even if the manifest lists lint-fix', () => {
    const base = makeCtx();
    const manifest: HouseManifest = {
      kitVersion: '1.0.0',
      installedAt: '2026-01-01T00:00:00.000Z',
      modules: ['core', 'lint-fix'],
      files: {},
    };
    const ctx: Ctx = {
      ...base,
      rootPkg: { name: 'solo', scripts: WHOLE_TREE },
      claude: { ...base.claude, houseConfig: null, manifest },
    };

    expect(checkFixPassPaths(ctx).findings).toEqual([]);
  });

  it('gives no finding for a lone target whose fixCommands is null', () => {
    const ctx = singlePackageCtx(WHOLE_TREE, { passPaths: true });
    const config = ctx.claude.houseConfig as unknown as {
      targets: Array<Record<string, unknown>>;
    };
    config.targets = [{ ...ROOT_TARGET, fixCommands: null }];

    expect(checkFixPassPaths(ctx).findings).toEqual([]);
  });

  it('gives no finding for a config with no targets whose fix.commands names a path-taking root script', () => {
    const ctx = singlePackageCtx(
      { 'lint:fix': 'eslint --fix' },
      { commands: ['lint:fix'] },
    );
    const config = ctx.claude.houseConfig as unknown as { targets: unknown[] };
    config.targets = [];

    expect(checkFixPassPaths(ctx).findings).toEqual([]);
  });
});
