import { existsSync, mkdirSync, symlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { makeCtx } from '#test/ctx-builder';
import type { HouseConfig } from '@houserules/api';
import type { HouseManifest } from '@houserules/api/internal';
import type { Ctx } from '../../../detect.js';
import { MODULES } from '../../../plan.js';
import type { Registry } from '../../../plugin-registry.js';
import { buildRegistry } from '../../../plugin-resolver.js';
import { checkInstallIntegrity } from '../install-integrity.js';
import type { PublishedVersionLookup } from '../install-integrity.js';

const KIT_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../..',
);
const FIXTURE_ROOT = join(KIT_ROOT, 'test/plugin-fixture');

function ensureFixtureSelfLink(): void {
  const link = join(FIXTURE_ROOT, 'node_modules', '@houserules', 'cli');
  if (existsSync(link)) return;
  mkdirSync(dirname(link), { recursive: true });
  symlinkSync(KIT_ROOT, link, 'dir');
}

function ctxWithFixturePlugin(modules: string[], files: string[] = []): Ctx {
  ensureFixtureSelfLink();
  const houseConfig = {
    version: 2,
    packageManager: 'pnpm',
    targets: [],
    plugins: [{ name: FIXTURE_ROOT, alias: 'fixture', config: {} }],
  } as unknown as HouseConfig;
  const manifest: HouseManifest = {
    kitVersion: '1.0.0',
    installedAt: '2026-01-01T00:00:00.000Z',
    modules,
    files: Object.fromEntries(files.map((f) => [f, 'deadbeef'])),
  };
  const base = makeCtx({
    git: { isRepo: false, top: '/repo', hasCommits: false, branch: 'main' },
  });
  return { ...base, claude: { ...base.claude, manifest, houseConfig } };
}

function registryFor(ctx: Ctx): Registry {
  return buildRegistry(FIXTURE_ROOT, ctx.claude.houseConfig ?? null, MODULES);
}

function retiredMessages(
  result: ReturnType<typeof checkInstallIntegrity>,
): string[] {
  return result.findings
    .filter((f) => f.msg.includes('no longer'))
    .map((f) => f.msg);
}

describe('checkInstallIntegrity, houserules version check', () => {
  it('warns when the manifest houserules version differs from the running CLI', () => {
    const ctx = ctxWithFixturePlugin(['fixture/fixture-core']);

    const result = checkInstallIntegrity(
      '/repo',
      ctx,
      '2.0.0',
      registryFor(ctx),
    );

    expect(
      result.findings.filter((f) => f.msg.includes('this CLI is v')),
    ).toEqual([
      expect.objectContaining({
        level: 'WARN',
        msg: 'installed houserules v1.0.0, this CLI is v2.0.0. Run: npx houserules update',
      }),
    ]);
  });

  it('does not warn when the manifest houserules version matches the running CLI', () => {
    const ctx = ctxWithFixturePlugin(['fixture/fixture-core']);

    const result = checkInstallIntegrity(
      '/repo',
      ctx,
      '1.0.0',
      registryFor(ctx),
    );

    expect(
      result.findings.filter((f) => f.msg.includes('this CLI is v')),
    ).toEqual([]);
  });
});

function ctxWithInstalledVersion(
  kitVersion: string,
  overrides: Partial<Ctx> = {},
): Ctx {
  const manifest: HouseManifest = {
    kitVersion,
    installedAt: '2026-01-01T00:00:00.000Z',
    modules: [],
    files: {},
  };
  const base = makeCtx({
    git: { isRepo: false, top: '/repo', hasCommits: false, branch: 'main' },
    ...overrides,
  });
  return { ...base, claude: { ...base.claude, manifest } };
}

function publishedAs(
  latest: string | null,
  env: NodeJS.ProcessEnv = {},
): PublishedVersionLookup & { calls: number } {
  const lookup = {
    env,
    calls: 0,
    latestVersion: () => {
      lookup.calls += 1;
      return latest;
    },
  };
  return lookup;
}

describe('checkInstallIntegrity, published version check', () => {
  it('names both versions and the update commands when the install is behind latest', () => {
    const ctx = ctxWithInstalledVersion('0.4.1');

    const result = checkInstallIntegrity(
      '/repo',
      ctx,
      '0.4.1',
      null,
      publishedAs('0.12.2'),
    );

    expect(result.readouts).toEqual([
      'installed houserules v0.4.1, latest published is v0.12.2. Update the CLI, then the install: npm install -D @houserules/cli@latest && npx houserules update',
    ]);
  });

  it('adds the CLI at a pnpm workspace root with -w', () => {
    const ctx = ctxWithInstalledVersion('1.0.0', {
      packageManager: { name: 'pnpm', source: 'lockfile' },
      isMonorepo: true,
    });

    const result = checkInstallIntegrity(
      '/repo',
      ctx,
      '1.0.0',
      null,
      publishedAs('1.1.0'),
    );

    expect(result.readouts).toEqual([
      'installed houserules v1.0.0, latest published is v1.1.0. Update the CLI, then the install: pnpm add -D -w @houserules/cli@latest && npx houserules update',
    ]);
  });

  it.each([
    {
      relation: 'behind, by numeric parts',
      installed: '0.4.1',
      latest: '0.12.2',
      lines: 1,
    },
    {
      relation: 'behind, a prerelease below its release',
      installed: '1.0.0-rc.1',
      latest: '1.0.0',
      lines: 1,
    },
    {
      relation: 'behind, numeric prerelease ids',
      installed: '1.0.0-rc.2',
      latest: '1.0.0-rc.10',
      lines: 1,
    },
    { relation: 'current', installed: '1.0.0', latest: '1.0.0', lines: 0 },
    {
      relation: 'ahead, by numeric parts',
      installed: '0.12.2',
      latest: '0.4.1',
      lines: 0,
    },
    {
      relation: 'ahead, a release above its prerelease',
      installed: '1.0.0',
      latest: '1.0.0-rc.1',
      lines: 0,
    },
  ])(
    'emits $lines readout(s) when the install is $relation',
    ({ installed, latest, lines }) => {
      const ctx = ctxWithInstalledVersion(installed);

      const result = checkInstallIntegrity(
        '/repo',
        ctx,
        installed,
        null,
        publishedAs(latest),
      );

      expect(result.readouts).toHaveLength(lines);
    },
  );

  it('leaves the running-CLI warning as the only advice when the running CLI is already at latest', () => {
    const ctx = ctxWithInstalledVersion('0.6.0');

    const result = checkInstallIntegrity(
      '/repo',
      ctx,
      '0.12.2',
      null,
      publishedAs('0.12.2'),
    );

    expect({
      readouts: result.readouts,
      findings: result.findings.map((f) => f.msg),
    }).toEqual({
      readouts: [],
      findings: [
        'installed houserules v0.6.0, this CLI is v0.12.2. Run: npx houserules update',
      ],
    });
  });

  it('stays silent, with no finding, when the lookup fails offline', () => {
    const ctx = ctxWithInstalledVersion('1.0.0');

    const result = checkInstallIntegrity(
      '/repo',
      ctx,
      '1.0.0',
      null,
      publishedAs(null),
    );

    expect(result).toEqual({ findings: [], readouts: [] });
  });

  it.each([
    { name: 'NO_UPDATE_NOTIFIER', env: { NO_UPDATE_NOTIFIER: '' } },
    { name: 'NODE_ENV=test', env: { NODE_ENV: 'test' } },
    { name: 'CI=true', env: { CI: 'true' } },
    { name: 'CONTINUOUS_INTEGRATION', env: { CONTINUOUS_INTEGRATION: '1' } },
    { name: 'a CI_* variable', env: { CI_JOB_ID: '42' } },
  ])('never asks the registry under $name', ({ env }) => {
    const ctx = ctxWithInstalledVersion('0.4.1');
    const lookup = publishedAs('0.12.2', env);

    const result = checkInstallIntegrity('/repo', ctx, '0.4.1', null, lookup);

    expect(
      { readouts: result.readouts, registryCalls: lookup.calls },
      'a skipped check must not reach the registry',
    ).toEqual({ readouts: [], registryCalls: 0 });
  });

  it('still asks the registry when CI is set to false', () => {
    const ctx = ctxWithInstalledVersion('0.4.1');

    const result = checkInstallIntegrity(
      '/repo',
      ctx,
      '0.4.1',
      null,
      publishedAs('0.12.2', { CI: 'false', CI_JOB_ID: '42' }),
    );

    expect(result.readouts).toHaveLength(1);
  });
});

describe('checkInstallIntegrity, plugin-aware retired-module check', () => {
  it('does not report a plugin-supplied module id as retired', () => {
    const ctx = ctxWithFixturePlugin(['fixture/fixture-core']);

    const result = checkInstallIntegrity(
      '/repo',
      ctx,
      '1.0.0',
      registryFor(ctx),
    );

    expect(retiredMessages(result)).toEqual([]);
  });

  it('still reports a manifest module id no built-in or plugin defines', () => {
    const ctx = ctxWithFixturePlugin(['fixture/fixture-core', 'nope']);

    const result = checkInstallIntegrity(
      '/repo',
      ctx,
      '1.0.0',
      registryFor(ctx),
    );

    expect(retiredMessages(result)).toEqual([
      expect.stringContaining('manifest lists module "nope"'),
    ]);
  });
});

describe('checkInstallIntegrity, plugin-aware retired-script check', () => {
  it('does not report a plugin-supplied hook script as retired', () => {
    const ctx = ctxWithFixturePlugin(
      ['fixture/fixture-core'],
      ['.claude/scripts/fixture-script.mjs'],
    );

    const result = checkInstallIntegrity(
      '/repo',
      ctx,
      '1.0.0',
      registryFor(ctx),
    );

    expect(
      result.findings.filter((f) =>
        f.msg.includes('retired houserules hook script'),
      ),
    ).toEqual([]);
  });

  it('still reports a script no payload, built-in or plugin, ships', () => {
    const ctx = ctxWithFixturePlugin(
      ['fixture/fixture-core'],
      ['.claude/scripts/ghost-script.mjs'],
    );

    const result = checkInstallIntegrity(
      '/repo',
      ctx,
      '1.0.0',
      registryFor(ctx),
    );

    expect(
      result.findings.filter((f) =>
        f.msg.includes('retired houserules hook script'),
      ),
    ).toEqual([
      expect.objectContaining({
        msg: expect.stringContaining(
          'retired houserules hook script ghost-script.mjs is no longer shipped',
        ),
      }),
    ]);
  });
});
