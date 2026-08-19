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
