import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, onTestFinished } from 'vitest';

import {
  SKIP_CASES,
  UPGRADE_CASES,
} from '../../../../payload/scripts/__tests__/update-check-cases.js';

import { makeCtx } from '#test/ctx-builder';
import { editHouseConfig } from '#test/installed-tree';
import { useInstalledRepo } from '#test/repo';
import type { HouseConfig } from '@houserules/api';
import type { HouseManifest } from '@houserules/api/internal';
import { detect } from '../../../detect.js';
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

const NOW = Date.parse('2026-11-22T12:00:00.000Z');
const HOUR_MS = 60 * 60 * 1000;

function cacheCheckedAgo(
  ageMs: number,
  latest: Record<string, string>,
): string {
  return JSON.stringify({
    checkedAt: new Date(NOW - ageMs).toISOString(),
    latest,
  });
}

function publishedAs(
  latest: string | null,
  env: NodeJS.ProcessEnv = {},
  cacheText: string | null = null,
): PublishedVersionLookup & { calls: number } {
  const lookup = {
    env,
    calls: 0,
    now: () => NOW,
    readCache: () => cacheText,
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

  it.each(SKIP_CASES)(
    'agrees with the session hook under $name, skipped $skipped',
    ({ env, skipped }) => {
      const ctx = ctxWithInstalledVersion('0.4.1');
      const lookup = publishedAs('0.12.2', env);

      checkInstallIntegrity('/repo', ctx, '0.4.1', null, lookup);

      expect({ askedRegistry: lookup.calls > 0 }).toEqual({
        askedRegistry: !skipped,
      });
    },
  );
});

function repoWith(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'kit-upgrade-'));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

describe('checkInstallIntegrity, upgrade command shared with the session hook', () => {
  it.each(UPGRADE_CASES)('names $command for $name', ({ files, command }) => {
    const root = repoWith(files);
    const detected = detect(root);
    const manifest: HouseManifest = {
      kitVersion: '1.0.0',
      installedAt: '2026-01-01T00:00:00.000Z',
      modules: [],
      files: {},
    };
    const ctx: Ctx = { ...detected, claude: { ...detected.claude, manifest } };

    const result = checkInstallIntegrity(
      root,
      ctx,
      '1.0.0',
      null,
      publishedAs('1.1.0'),
    );

    expect(result.readouts).toEqual([
      `installed houserules v1.0.0, latest published is v1.1.0. Update the CLI, then the install: ${command} && npx houserules update`,
    ]);
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

const HOOK_WIRING_FILE = '.claude/scripts/hook-wiring.json';

function readJsonFile(root: string, path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(root, path), 'utf8'));
}

function writeJsonFile(root: string, path: string, value: unknown): void {
  writeFileSync(join(root, path), JSON.stringify(value, null, 2) + '\n');
}

/**
 * Records `script` as an installed hook script no payload ships, the state a release that drops
 * a dispatched hook leaves behind, and lists it in the dispatcher's wiring when `dispatched`.
 */
function retireScript(root: string, script: string, dispatched: boolean): void {
  writeFileSync(join(root, '.claude/scripts', script), '');
  const manifest = readJsonFile(root, MANIFEST_FILE) as {
    files: Record<string, string>;
  };
  manifest.files[`.claude/scripts/${script}`] = 'deadbeef';
  writeJsonFile(root, MANIFEST_FILE, manifest);
  if (!dispatched) return;
  const wiring = readJsonFile(root, HOOK_WIRING_FILE) as {
    events: Record<string, { script: string }[]>;
  };
  wiring.events.PreToolUse = [...(wiring.events.PreToolUse ?? []), { script }];
  writeJsonFile(root, HOOK_WIRING_FILE, wiring);
}

function retiredScriptMessages(root: string): string[] {
  const ctx = detect(root);
  const kitVersion = ctx.claude.manifest?.kitVersion ?? '';
  return checkInstallIntegrity(root, ctx, kitVersion, null, publishedAs(null))
    .findings.map((finding) => finding.msg)
    .filter((msg) => msg.startsWith('retired houserules hook script'));
}

describe('checkInstallIntegrity, retired-script check under hook dispatch', () => {
  it('reports a retired script the hook wiring still dispatches as still wired', () => {
    const root = useInstalledRepo('npm-single');
    retireScript(root, 'ghost-hook.mjs', true);

    expect(retiredScriptMessages(root)).toEqual([
      'retired houserules hook script ghost-hook.mjs is no longer shipped by houserules but is still wired (a dead node process on every trigger) — prune it: npx houserules update',
    ]);
  });

  it('reports a retired script the hook wiring no longer lists without the wired clause', () => {
    const root = useInstalledRepo('npm-single');
    retireScript(root, 'ghost-hook.mjs', false);

    expect(retiredScriptMessages(root)).toEqual([
      'retired houserules hook script ghost-hook.mjs is no longer shipped by houserules — prune it: npx houserules update',
    ]);
  });
});

describe('checkInstallIntegrity, given a config and a manifest that disagree on modules', () => {
  it('flags the unknown module the config names, not the manifest ones', () => {
    const ctx = ctxWithFixturePlugin(['fixture/fixture-core']);
    const disagreeing: Ctx = {
      ...ctx,
      claude: {
        ...ctx.claude,
        houseConfig: {
          ...ctx.claude.houseConfig,
          modules: ['config-only-ghost'],
        } as unknown as HouseConfig,
      },
    };

    const result = checkInstallIntegrity(
      '/repo',
      disagreeing,
      '1.0.0',
      registryFor(disagreeing),
    );

    expect(result.findings).toContainEqual(
      expect.objectContaining({
        msg: expect.stringContaining('"config-only-ghost"'),
      }),
    );
  });
});

const MANIFEST_FILE = '.claude/houserules.manifest.json';

function trackManifest(root: string): void {
  execFileSync('git', ['add', '-f', MANIFEST_FILE], { cwd: root });
}

function manifestTrackedFindings(root: string, kitVersion: string) {
  const ctx = detect(root);
  return checkInstallIntegrity(root, ctx, kitVersion, null).findings.filter(
    (finding) => finding.id === 'manifest-tracked',
  );
}

describe('checkInstallIntegrity, given a tracked manifest', () => {
  it('raises manifest-tracked naming update with no flags when the ignore block lists it', () => {
    const root = useInstalledRepo('npm-single');
    trackManifest(root);

    const [finding, ...rest] = manifestTrackedFindings(root, '1.0.0');

    expect(rest).toEqual([]);
    expect(finding).toMatchObject({ level: 'WARN', id: 'manifest-tracked' });
    expect(finding?.msg).toContain('local state');
    expect(finding?.msg).toMatch(/npx houserules update$/);
  });

  it('raises nothing when the manifest is untracked', () => {
    const root = useInstalledRepo('npm-single');
    execFileSync(
      'git',
      ['rm', '--cached', '-q', '--ignore-unmatch', MANIFEST_FILE],
      {
        cwd: root,
      },
    );

    expect(manifestTrackedFindings(root, '1.0.0')).toEqual([]);
  });

  it('raises nothing under payload.commit: true', () => {
    const root = useInstalledRepo('npm-single');
    trackManifest(root);
    editHouseConfig(root, (config) => {
      config.payload = { commit: true };
    });

    expect(manifestTrackedFindings(root, '1.0.0')).toEqual([]);
  });

  it('raises nothing when .claude/.gitignore holds no payload block', () => {
    const root = useInstalledRepo('npm-single');
    trackManifest(root);
    writeFileSync(join(root, '.claude', '.gitignore'), '/scripts/\n');

    expect(manifestTrackedFindings(root, '1.0.0')).toEqual([]);
  });

  it('raises nothing outside a git work tree', () => {
    const root = useInstalledRepo('npm-single');
    trackManifest(root);
    rmSync(join(root, '.git'), { recursive: true, force: true });

    expect(manifestTrackedFindings(root, '1.0.0')).toEqual([]);
  });
});

describe('checkInstallIntegrity, version-check cache', () => {
  const BEHIND =
    'installed houserules v0.4.1, latest published is v0.12.2. Update the CLI, then the install: npm install -D @houserules/cli@latest && npx houserules update';

  it.each([
    { age: '25 hours', ageMs: 25 * HOUR_MS },
    { age: 'exactly 24 hours', ageMs: 24 * HOUR_MS },
  ])(
    'asks the registry and keeps the findings when the cache is $age old',
    ({ ageMs }) => {
      const ctx = ctxWithInstalledVersion('0.4.1');
      const lookup = publishedAs(
        '0.12.2',
        {},
        cacheCheckedAgo(ageMs, { '@houserules/cli': '0.4.1' }),
      );

      const result = checkInstallIntegrity('/repo', ctx, '0.4.1', null, lookup);

      expect({
        readouts: result.readouts,
        findings: result.findings,
        calls: lookup.calls,
      }).toEqual({ readouts: [BEHIND], findings: [], calls: 1 });
    },
  );

  it.each([
    { age: '23 hours', ageMs: 23 * HOUR_MS },
    { age: 'a minute', ageMs: 60 * 1000 },
  ])(
    'prints the readout from a cache $age old naming a newer version, with no live call',
    ({ ageMs }) => {
      const ctx = ctxWithInstalledVersion('0.4.1');
      const lookup = publishedAs(
        '9.9.9',
        {},
        cacheCheckedAgo(ageMs, { '@houserules/cli': '0.12.2' }),
      );

      const result = checkInstallIntegrity('/repo', ctx, '0.4.1', null, lookup);

      expect({ readouts: result.readouts, calls: lookup.calls }).toEqual({
        readouts: [BEHIND],
        calls: 0,
      });
    },
  );

  it('prints nothing from a fresh cache naming the current version, with no live call', () => {
    const ctx = ctxWithInstalledVersion('0.4.1');
    const lookup = publishedAs(
      '9.9.9',
      {},
      cacheCheckedAgo(HOUR_MS, { '@houserules/cli': '0.4.1' }),
    );

    const result = checkInstallIntegrity('/repo', ctx, '0.4.1', null, lookup);

    expect({ readouts: result.readouts, calls: lookup.calls }).toEqual({
      readouts: [],
      calls: 0,
    });
  });

  it('makes no live call when a fresh cache lacks the CLI entry', () => {
    const ctx = ctxWithInstalledVersion('0.4.1');
    const lookup = publishedAs('9.9.9', {}, cacheCheckedAgo(HOUR_MS, {}));

    const result = checkInstallIntegrity('/repo', ctx, '0.4.1', null, lookup);

    expect({ readouts: result.readouts, calls: lookup.calls }).toEqual({
      readouts: [],
      calls: 0,
    });
  });

  it('falls back to the live lookup when the cache is corrupt', () => {
    const ctx = ctxWithInstalledVersion('0.4.1');
    const lookup = publishedAs('0.12.2', {}, '{not json');

    const result = checkInstallIntegrity('/repo', ctx, '0.4.1', null, lookup);

    expect({ readouts: result.readouts, calls: lookup.calls }).toEqual({
      readouts: [BEHIND],
      calls: 1,
    });
  });

  it('makes no call and prints nothing when the config sets versionCheck to false', () => {
    const base = ctxWithInstalledVersion('0.4.1');
    const ctx: Ctx = {
      ...base,
      claude: {
        ...base.claude,
        houseConfig: {
          ...base.claude.houseConfig,
          versionCheck: false,
        } as unknown as HouseConfig,
      },
    };
    const lookup = publishedAs(
      '0.12.2',
      {},
      cacheCheckedAgo(HOUR_MS, { '@houserules/cli': '0.12.2' }),
    );

    const result = checkInstallIntegrity('/repo', ctx, '0.4.1', null, lookup);

    expect({ readouts: result.readouts, calls: lookup.calls }).toEqual({
      readouts: [],
      calls: 0,
    });
  });
});
