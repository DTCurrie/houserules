import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
} from 'vitest';
import { spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  existsSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  globalManager,
  isNewer,
  isVersionCheckSkipped,
  localManager,
  needsCheck,
  parseCache,
  upgradeCommand,
  versionNotices,
} from '../payload-sync.mjs';

const SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'payload-dist/scripts/payload-sync.mjs',
);
const MANIFEST = '.claude/houserules.manifest.json';
const CACHE = '.claude/state/version-check.json';
const CONFIG = '.claude/houserules.config.json';
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const NOW = Date.parse('2026-11-22T12:00:00.000Z');
const SETTLE_MS = 1000;
const POLL_LIMIT_MS = 10_000;
const UNREACHABLE_REGISTRY = 'http://127.0.0.1:1';

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kit-sync-'));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function put(root: string, rel: string, content: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), content);
}

function stubCli(
  packageDir: string,
  version: string,
  argvFile: string,
): string {
  put(
    packageDir,
    'package.json',
    JSON.stringify({ name: '@houserules/cli', version }),
  );
  const bin = join(packageDir, 'bin/houserules.js');
  put(
    packageDir,
    'bin/houserules.js',
    `#!/usr/bin/env node
require('node:fs').writeFileSync(${JSON.stringify(argvFile)}, process.argv.slice(2).join(' '));
console.log('[houserules] synced 3 files');
`,
  );
  chmodSync(bin, 0o755);
  return bin;
}

function writeManifest(
  root: string,
  manifest: Record<string, unknown> | string,
): void {
  put(
    root,
    MANIFEST,
    typeof manifest === 'string' ? manifest : JSON.stringify(manifest),
  );
}

function nodeDir(): string {
  const dir = tmp();
  symlinkSync(process.execPath, join(dir, 'node'));
  return dir;
}

interface Registry {
  url: string;
  latest: Record<string, string>;
  requests: { name: string; headers: Record<string, unknown> }[];
}

const registry: Registry = { url: '', latest: {}, requests: [] };
let server: Server;

beforeAll(async () => {
  server = createServer((request, response) => {
    const match = /^\/-\/package\/(.+)\/dist-tags$/.exec(request.url ?? '');
    const name = match ? decodeURIComponent(match[1]!) : '';
    registry.requests.push({ name, headers: { ...request.headers } });
    const latest = registry.latest[name];
    if (!latest) {
      response.writeHead(404).end();
      return;
    }
    response
      .writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ latest }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  registry.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

beforeEach(() => {
  registry.latest = {};
  registry.requests = [];
});

const QUIET = { NO_UPDATE_NOTIFIER: '1' };

function run(
  root: string,
  pathDir: string = nodeDir(),
  env: Record<string, string> = QUIET,
) {
  const path = `${pathDir}:/bin:/usr/bin`;
  const r = spawnSync(process.execPath, [SCRIPT], {
    cwd: root,
    encoding: 'utf8',
    env: {
      PATH: path,
      CLAUDE_PROJECT_DIR: root,
      npm_config_registry: registry.url,
      ...env,
    },
  });
  return { status: r.status, stdout: r.stdout.trim() };
}

function lines(stdout: string): string[] {
  return stdout.split('\n').filter(Boolean);
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + POLL_LIMIT_MS;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition never held');
    await sleep(25);
  }
}

function readCache(root: string): {
  checkedAt: string;
  latest: Record<string, string>;
  announced?: Record<string, { version: string; at: string }>;
} {
  return JSON.parse(readFileSync(join(root, CACHE), 'utf8'));
}

function writeCache(root: string, cache: Record<string, unknown>): void {
  put(root, CACHE, JSON.stringify(cache));
}

function cacheCheckedAt(root: string): string | undefined {
  try {
    return readCache(root).checkedAt;
  } catch {
    return undefined;
  }
}

function ageCache(root: string, ms: number): void {
  const cache = readCache(root);
  const shift = (iso: string) => new Date(Date.parse(iso) - ms).toISOString();
  cache.checkedAt = shift(cache.checkedAt);
  for (const entry of Object.values(cache.announced ?? {}))
    entry.at = shift(entry.at);
  writeCache(root, cache);
}

function hoursAgo(hours: number): string {
  return new Date(Date.now() - hours * HOUR_MS).toISOString();
}

describe('payload-sync.mjs', () => {
  let root: string;
  let argvFile: string;

  beforeEach(() => {
    root = tmp();
    argvFile = join(tmp(), 'argv');
    stubCli(join(root, 'node_modules/@houserules/cli'), '2.0.0', argvFile);
    mkdirSync(join(root, 'node_modules/.bin'), { recursive: true });
    symlinkSync(
      join(root, 'node_modules/@houserules/cli/bin/houserules.js'),
      join(root, 'node_modules/.bin/houserules'),
    );
    put(root, '.claude/scripts/a.mjs', 'x');
  });

  function current(
    extra: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      kitVersion: '2.0.0',
      files: { '.claude/scripts/a.mjs': 'h' },
      ...extra,
    };
  }

  function installPlugin(name: string, version: string): void {
    put(
      root,
      `node_modules/${name}/package.json`,
      JSON.stringify({ name, version }),
    );
  }

  const synced = (r: { stdout: string }, kit?: string) =>
    expect(r.stdout.split('\n')).toEqual([
      '[houserules] synced 3 files',
      expect.stringContaining('Restart the session'),
      ...(kit ? [`[houserules] kit ${kit}`] : []),
    ]);

  it('spawns no sync and prints only the kit line on a current install', () => {
    writeManifest(root, current());

    const r = run(root);

    expect(r).toEqual({ status: 0, stdout: '[houserules] kit 2.0.0' });
    expect(existsSync(argvFile)).toBe(false);
  });

  it('syncs when the manifest kitVersion is older than the CLI', () => {
    writeManifest(root, current({ kitVersion: '1.0.0' }));

    const r = run(root);

    expect(r.status).toBe(0);
    synced(r, '1.0.0');
    expect(readFileSync(argvFile, 'utf8')).toBe(`update --sync ${root}`);
  });

  it('syncs when a recorded dest is missing on disk', () => {
    writeManifest(
      root,
      current({ files: { '.claude/scripts/gone.mjs': 'h' } }),
    );

    const r = run(root);

    expect(r.status).toBe(0);
    synced(r, '2.0.0');
    expect(readFileSync(argvFile, 'utf8')).toBe(`update --sync ${root}`);
  });

  it('syncs and prints no kit line when the manifest is missing', () => {
    const r = run(root);

    expect(r.status).toBe(0);
    synced(r);
    expect(readFileSync(argvFile, 'utf8')).toBe(`update --sync ${root}`);
  });

  it('syncs and prints no kit line when the manifest does not parse', () => {
    writeManifest(root, '{ nope');

    const r = run(root);

    expect(r.status).toBe(0);
    synced(r);
  });

  it('syncs when an installed plugin differs from the manifest version', () => {
    installPlugin('@houserules/plugin-x', '3.0.0');
    writeManifest(
      root,
      current({
        plugins: [
          { name: '@houserules/plugin-x', alias: 'x', version: '2.0.0' },
        ],
      }),
    );

    const r = run(root);

    expect(r.status).toBe(0);
    synced(r, '2.0.0');
  });

  it('does not compare a plugin that has no package.json in node_modules', () => {
    writeManifest(
      root,
      current({
        plugins: [
          { name: '@houserules/plugin-y', alias: 'y', version: '2.0.0' },
        ],
      }),
    );

    expect(run(root)).toEqual({ status: 0, stdout: '[houserules] kit 2.0.0' });
    expect(existsSync(argvFile)).toBe(false);
  });

  it('exits 0 and prints the child output when the sync child fails', () => {
    writeManifest(root, current({ kitVersion: '1.0.0' }));
    put(
      root,
      'node_modules/@houserules/cli/bin/houserules.js',
      '#!/usr/bin/env node\nconsole.log("[houserules] boom");\nprocess.exit(1);\n',
    );

    expect(run(root)).toEqual({
      status: 0,
      stdout: '[houserules] boom\n[houserules] kit 1.0.0',
    });
  });

  describe('version notice', () => {
    it('spawns one detached check on a stale cache, which writes the cache', async () => {
      writeManifest(root, current());
      put(root, 'package-lock.json', '{}');
      registry.latest = { '@houserules/cli': '2.1.0' };
      writeCache(root, { checkedAt: hoursAgo(30), latest: {} });

      const r = run(root, nodeDir(), {});

      expect(r).toEqual({ status: 0, stdout: '[houserules] kit 2.0.0' });
      await until(() => readCache(root).latest['@houserules/cli'] === '2.1.0');
      expect(registry.requests).toEqual([
        {
          name: '@houserules/cli',
          headers: expect.objectContaining({ 'user-agent': 'houserules' }),
        },
      ]);
      expect(Date.now() - Date.parse(readCache(root).checkedAt)).toBeLessThan(
        HOUR_MS,
      );
    });

    it('makes no request on a fresh cache and prints its notice', async () => {
      writeManifest(root, current());
      put(root, 'package-lock.json', '{}');
      registry.latest = { '@houserules/cli': '2.1.0' };
      writeCache(root, {
        checkedAt: hoursAgo(1),
        latest: { '@houserules/cli': '2.1.0' },
      });

      const r = run(root, nodeDir(), {});
      await sleep(SETTLE_MS);

      expect(lines(r.stdout)).toEqual([
        '[houserules] kit 2.0.0',
        '[houserules] 2.1.0 available (installed 2.0.0). Upgrade: npm install -D @houserules/cli@latest',
      ]);
      expect(registry.requests).toEqual([]);
    });

    it('announces a version once a day and checks once a day across the boundary', async () => {
      writeManifest(root, current());
      put(root, 'yarn.lock', '');
      registry.latest = { '@houserules/cli': '2.1.0' };
      const printed: string[] = [];
      const runOnce = () => {
        const r = run(root, nodeDir(), {});
        expect(r.status).toBe(0);
        printed.push(...lines(r.stdout).filter((l) => l.includes('available')));
      };

      runOnce();
      await until(() => cacheCheckedAt(root) !== undefined);
      runOnce();
      runOnce();
      ageCache(root, 23 * HOUR_MS);
      runOnce();
      await sleep(SETTLE_MS);

      expect(registry.requests).toHaveLength(1);
      expect(printed).toEqual([
        '[houserules] 2.1.0 available (installed 2.0.0). Upgrade: yarn add -D @houserules/cli@latest',
      ]);

      ageCache(root, 2 * HOUR_MS);
      const agedCheckedAt = cacheCheckedAt(root);
      runOnce();
      await until(() => cacheCheckedAt(root) !== agedCheckedAt);
      runOnce();
      await sleep(SETTLE_MS);

      expect(registry.requests).toHaveLength(2);
      expect(printed).toHaveLength(2);
      expect(printed[1]).toBe(printed[0]);
      expect(readCache(root).announced?.['@houserules/cli']?.version).toBe(
        '2.1.0',
      );
    });

    describe('skipped', () => {
      beforeEach(() => {
        writeManifest(root, current());
        registry.latest = { '@houserules/cli': '2.1.0' };
        writeCache(root, {
          checkedAt: hoursAgo(48),
          latest: { '@houserules/cli': '2.1.0' },
        });
      });

      it.each([
        ['NO_UPDATE_NOTIFIER set', { NO_UPDATE_NOTIFIER: '' }],
        ['NODE_ENV=test', { NODE_ENV: 'test' }],
        ['CI=1', { CI: '1' }],
        ['CONTINUOUS_INTEGRATION=1', { CONTINUOUS_INTEGRATION: '1' }],
        ['CI_X=1', { CI_X: '1' }],
      ])(
        'makes no request and prints no notice with %s',
        async (_label, env) => {
          const r = run(root, nodeDir(), env);
          await sleep(SETTLE_MS);

          expect(r).toEqual({ status: 0, stdout: '[houserules] kit 2.0.0' });
          expect(registry.requests).toEqual([]);
        },
      );

      it('makes no request and prints no notice with versionCheck false in config', async () => {
        put(root, CONFIG, JSON.stringify({ versionCheck: false }));

        const r = run(root, nodeDir(), {});
        await sleep(SETTLE_MS);

        expect(r).toEqual({ status: 0, stdout: '[houserules] kit 2.0.0' });
        expect(registry.requests).toEqual([]);
      });

      it('still checks and notifies under CI=false', async () => {
        const r = run(root, nodeDir(), { CI: 'false' });
        await until(() => registry.requests.length > 0);
        await until(
          () => Date.now() - Date.parse(cacheCheckedAt(root)!) < HOUR_MS,
        );

        expect(lines(r.stdout)).toEqual([
          '[houserules] kit 2.0.0',
          '[houserules] 2.1.0 available (installed 2.0.0). Upgrade: npm install -D @houserules/cli@latest',
        ]);
      });
    });

    it('prints no notice and exits 0 when the registry is unreachable', async () => {
      writeManifest(root, current());

      const first = run(root, nodeDir(), {
        npm_config_registry: UNREACHABLE_REGISTRY,
      });
      await until(() => cacheCheckedAt(root) !== undefined);
      const second = run(root, nodeDir(), {
        npm_config_registry: UNREACHABLE_REGISTRY,
      });

      expect(first).toEqual({ status: 0, stdout: '[houserules] kit 2.0.0' });
      expect(second).toEqual({ status: 0, stdout: '[houserules] kit 2.0.0' });
      expect(readCache(root).latest).toEqual({});
    });

    it('adds -w at a pnpm workspace root', () => {
      writeManifest(root, current());
      put(root, 'pnpm-lock.yaml', '');
      put(root, 'pnpm-workspace.yaml', 'packages: []\n');
      writeCache(root, {
        checkedAt: hoursAgo(1),
        latest: { '@houserules/cli': '3.0.0' },
      });

      expect(lines(run(root, nodeDir(), {}).stdout)).toEqual([
        '[houserules] kit 2.0.0',
        '[houserules] 3.0.0 available (installed 2.0.0). Upgrade: pnpm add -D -w @houserules/cli@latest',
      ]);
    });

    it('prints a line per behind plugin after the CLI line', () => {
      installPlugin('@houserules/plugin-x', '1.0.0');
      installPlugin('@houserules/plugin-y', '1.4.0');
      installPlugin('@houserules/plugin-z', '1.0.0');
      installPlugin('houserules-plugin-local', '0.1.0');
      writeManifest(
        root,
        current({
          plugins: [
            { name: '@houserules/plugin-x', alias: 'x', version: '1.0.0' },
            { name: '@houserules/plugin-y', alias: 'y', version: '1.4.0' },
            { name: '@houserules/plugin-z', alias: 'z', version: '1.0.0' },
            { name: 'houserules-plugin-local', alias: 'l', version: '0.1.0' },
          ],
        }),
      );
      put(root, 'bun.lock', '');
      writeCache(root, {
        checkedAt: hoursAgo(1),
        latest: {
          '@houserules/plugin-x': '1.2.0',
          '@houserules/plugin-y': '1.10.0',
          '@houserules/plugin-z': '1.0.0',
          '@houserules/cli': '2.0.1',
          'houserules-plugin-local': '9.0.0',
        },
      });

      expect(lines(run(root, nodeDir(), {}).stdout)).toEqual([
        '[houserules] kit 2.0.0',
        '[houserules] 2.0.1 available (installed 2.0.0). Upgrade: bun add -D @houserules/cli@latest',
        '[houserules] @houserules/plugin-x 1.2.0 available (installed 1.0.0). Upgrade: bun add -D @houserules/plugin-x@latest',
        '[houserules] @houserules/plugin-y 1.10.0 available (installed 1.4.0). Upgrade: bun add -D @houserules/plugin-y@latest',
      ]);
      expect(Object.keys(readCache(root).announced ?? {}).sort()).toEqual([
        '@houserules/cli',
        '@houserules/plugin-x',
        '@houserules/plugin-y',
      ]);
    });
  });

  describe('with no local CLI', () => {
    let pathDir: string;

    beforeEach(() => {
      rmSync(join(root, 'node_modules'), { recursive: true, force: true });
      pathDir = nodeDir();
    });

    it('uses a global houserules found on PATH', () => {
      const globalPackage = join(tmp(), 'lib/node_modules/@houserules/cli');
      const bin = stubCli(globalPackage, '2.0.0', argvFile);
      symlinkSync(bin, join(pathDir, 'houserules'));
      writeManifest(root, current({ kitVersion: '1.0.0' }));

      const r = run(root, pathDir);

      expect(r.status).toBe(0);
      synced(r, '1.0.0');
      expect(readFileSync(argvFile, 'utf8')).toBe(`update --sync ${root}`);
    });

    it('spawns no sync when the global CLI matches the manifest', () => {
      const globalPackage = join(tmp(), 'lib/node_modules/@houserules/cli');
      const bin = stubCli(globalPackage, '2.0.0', argvFile);
      symlinkSync(bin, join(pathDir, 'houserules'));
      writeManifest(root, current());

      expect(run(root, pathDir)).toEqual({
        status: 0,
        stdout: '[houserules] kit 2.0.0',
      });
      expect(existsSync(argvFile)).toBe(false);
    });

    it.each([
      ['npm', 'lib/node_modules', 'npm install -g'],
      ['pnpm', 'pnpm/global/5/node_modules', 'pnpm add -g'],
    ])(
      'announces against the global CLI with the %s global upgrade command',
      (_manager, globalDir, command) => {
        put(root, 'pnpm-lock.yaml', '');
        const globalPackage = join(tmp(), globalDir, '@houserules/cli');
        const bin = stubCli(globalPackage, '2.3.0', argvFile);
        symlinkSync(bin, join(pathDir, 'houserules'));
        writeManifest(root, current({ kitVersion: '2.3.0' }));
        writeCache(root, {
          checkedAt: hoursAgo(1),
          latest: { '@houserules/cli': '2.4.0' },
        });

        expect(lines(run(root, pathDir, {}).stdout)).toEqual([
          '[houserules] kit 2.3.0',
          `[houserules] 2.4.0 available (installed 2.3.0). Upgrade: ${command} @houserules/cli@latest`,
        ]);
      },
    );

    it('prints an install hint without npx when no CLI exists', () => {
      writeManifest(root, current());

      const r = run(root, pathDir);

      expect(r.status).toBe(0);
      expect(lines(r.stdout)).toEqual([
        expect.stringMatching(/^\[houserules\] .*[Ii]nstall/),
        '[houserules] kit 2.0.0',
      ]);
      expect(r.stdout).not.toContain('npx');
      expect(existsSync(argvFile)).toBe(false);
    });
  });
});

describe('isVersionCheckSkipped', () => {
  it.each([
    [{}, {}, false],
    [{ NO_UPDATE_NOTIFIER: '' }, {}, true],
    [{ NODE_ENV: 'test' }, {}, true],
    [{ NODE_ENV: 'production' }, {}, false],
    [{ CI: '1' }, {}, true],
    [{ CI: 'false' }, {}, false],
    [{ CI: '0', CI_X: '1' }, {}, false],
    [{ CONTINUOUS_INTEGRATION: '1' }, {}, true],
    [{ CI_PIPELINE_ID: '7' }, {}, true],
    [{}, { versionCheck: false }, true],
    [{}, { versionCheck: true }, false],
    [{}, undefined, false],
  ])('env %j with config %j is %s', (env, config, expected) => {
    expect(isVersionCheckSkipped(env, config)).toBe(expected);
  });
});

describe('isNewer', () => {
  it.each([
    ['2.1.0', '2.0.0', true],
    ['2.0.10', '2.0.9', true],
    ['10.0.0', '9.9.9', true],
    ['2.0.0', '2.0.0', false],
    ['1.9.9', '2.0.0', false],
    ['3.0.0-beta.1', '2.0.0', false],
    ['2.0.0', '2.0.0-rc.1', true],
    ['latest', '2.0.0', false],
  ])('latest %s over installed %s is %s', (latest, installed, expected) => {
    expect(isNewer(latest, installed)).toBe(expected);
  });
});

describe('localManager', () => {
  it.each([
    [['pnpm-lock.yaml', 'package-lock.json'], 'pnpm'],
    [['yarn.lock', 'package-lock.json'], 'yarn'],
    [['bun.lockb'], 'bun'],
    [['package-lock.json'], 'npm'],
    [[], 'npm'],
  ])('lockfiles %j choose %s', (lockfiles, expected) => {
    const dir = tmp();
    for (const lockfile of lockfiles) put(dir, lockfile, '');
    expect(localManager(dir)).toBe(expected);
  });
});

describe('globalManager', () => {
  it.each([
    [
      '/Users/me/Library/pnpm/global/5/node_modules/@houserules/cli/bin/x.mjs',
      'pnpm',
    ],
    ['/Users/me/Library/pnpm/houserules', 'pnpm'],
    [
      '/Users/me/.config/yarn/global/node_modules/@houserules/cli/bin/x.mjs',
      'yarn',
    ],
    [
      '/Users/me/.bun/install/global/node_modules/@houserules/cli/bin/x.mjs',
      'bun',
    ],
    ['/usr/local/lib/node_modules/@houserules/cli/bin/x.mjs', 'npm'],
    [
      '/Users/yarnfan/.nvm/versions/node/v24/lib/node_modules/@houserules/cli/bin/x.mjs',
      'npm',
    ],
  ])('%s is %s', (path, expected) => {
    expect(globalManager(path)).toBe(expected);
  });
});

describe('upgradeCommand', () => {
  it.each([
    [
      { scope: 'local', manager: 'npm', isWorkspaceRoot: true },
      'npm install -D @houserules/cli@latest',
    ],
    [
      { scope: 'local', manager: 'pnpm', isWorkspaceRoot: false },
      'pnpm add -D @houserules/cli@latest',
    ],
    [
      { scope: 'local', manager: 'pnpm', isWorkspaceRoot: true },
      'pnpm add -D -w @houserules/cli@latest',
    ],
    [
      { scope: 'local', manager: 'yarn', isWorkspaceRoot: true },
      'yarn add -D @houserules/cli@latest',
    ],
    [
      { scope: 'global', manager: 'npm' },
      'npm install -g @houserules/cli@latest',
    ],
    [
      { scope: 'global', manager: 'pnpm' },
      'pnpm add -g @houserules/cli@latest',
    ],
    [
      { scope: 'global', manager: 'yarn' },
      'yarn global add @houserules/cli@latest',
    ],
    [{ scope: 'global', manager: 'bun' }, 'bun add -g @houserules/cli@latest'],
  ] as const)('%j is %s', (upgrade, expected) => {
    expect(upgradeCommand('@houserules/cli', upgrade)).toBe(expected);
  });
});

describe('needsCheck', () => {
  it.each([
    ['no cache', undefined, true],
    ['an unparseable checkedAt', { checkedAt: 'soon', latest: {} }, true],
    [
      'a check one ms inside the day',
      { checkedAt: new Date(NOW - DAY_MS + 1).toISOString(), latest: {} },
      false,
    ],
    [
      'a check exactly a day old',
      { checkedAt: new Date(NOW - DAY_MS).toISOString(), latest: {} },
      true,
    ],
  ])('is %s for %s', (_label, cache, expected) => {
    expect(needsCheck(cache, NOW)).toBe(expected);
  });
});

describe('parseCache', () => {
  it.each([
    [undefined, false],
    ['text', false],
    [{ latest: {} }, false],
    [{ checkedAt: 'x' }, false],
    [{ checkedAt: 'x', latest: {} }, true],
  ])('%j parses: %s', (raw, expected) => {
    expect(parseCache(raw) !== undefined).toBe(expected);
  });
});

describe('versionNotices', () => {
  const cli = {
    name: '@houserules/cli',
    version: '2.0.0',
    upgrade: { scope: 'local', manager: 'npm', isWorkspaceRoot: false },
  } as const;
  const line =
    '[houserules] 2.1.0 available (installed 2.0.0). Upgrade: npm install -D @houserules/cli@latest';

  function cacheAnnouncedAt(version: string, at: number) {
    return {
      checkedAt: new Date(NOW).toISOString(),
      latest: { '@houserules/cli': '2.1.0' },
      announced: {
        '@houserules/cli': { version, at: new Date(at).toISOString() },
      },
    };
  }

  it('announces and records the version and time', () => {
    const result = versionNotices(
      {
        checkedAt: new Date(NOW).toISOString(),
        latest: { '@houserules/cli': '2.1.0' },
      },
      [cli],
      NOW,
    );

    expect(result).toEqual({
      lines: [line],
      announced: {
        '@houserules/cli': {
          version: '2.1.0',
          at: new Date(NOW).toISOString(),
        },
      },
    });
  });

  it('stays silent one ms before a day has passed since the same announcement', () => {
    expect(
      versionNotices(cacheAnnouncedAt('2.1.0', NOW - DAY_MS + 1), [cli], NOW)
        .lines,
    ).toEqual([]);
  });

  it('announces again once a day has passed', () => {
    expect(
      versionNotices(cacheAnnouncedAt('2.1.0', NOW - DAY_MS), [cli], NOW).lines,
    ).toEqual([line]);
  });

  it('announces a different version within the day', () => {
    expect(
      versionNotices(cacheAnnouncedAt('2.0.5', NOW - HOUR_MS), [cli], NOW)
        .lines,
    ).toEqual([line]);
  });

  it('prints nothing when current or when the cache lacks the package', () => {
    expect(
      versionNotices(
        {
          checkedAt: new Date(NOW).toISOString(),
          latest: { '@houserules/cli': '2.0.0' },
        },
        [cli, { ...cli, name: '@houserules/plugin-x' }],
        NOW,
      ).lines,
    ).toEqual([]);
  });
});
