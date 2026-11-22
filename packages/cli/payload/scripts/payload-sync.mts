#!/usr/bin/env node
/**
 * SessionStart hook. Brings a stale or incomplete install back in line with the installed
 * CLI: when the manifest, the CLI version, a plugin version, or a recorded file disagrees
 * with what is on disk, it runs the CLI's `update --sync`.
 *
 * It then prints the installed kit version, and once a day per package a line when the
 * version-check cache names a newer release. A missing or day-old cache spawns
 * `version-check.mjs` detached, so session start never waits on the network.
 *
 * On a current install with a local CLI and a fresh cache it reads small files only.
 * Every path exits 0. Node builtins only, since it runs standalone in a user's repo.
 */

import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MANIFEST = '.claude/houserules.manifest.json';
const CONFIG = '.claude/houserules.config.json';
/** Mirrors `VERSION_CHECK_CACHE_PATH` in `@houserules/api`, which a payload script cannot import. */
const VERSION_CHECK_CACHE = '.claude/state/version-check.json';
/** Mirrors `VERSION_CHECK_TTL_MS` in `@houserules/api`: one day. */
const VERSION_CHECK_TTL_MS = 24 * 60 * 60 * 1000;
const PLUGIN_SCOPE = '@houserules/';
const CLI_NAME = '@houserules/cli';
const INSTALL_HINT =
  '[houserules] CLI not found. Install it as a dependency (pnpm add -D @houserules/cli, or your package manager equivalent) to sync the payload.';

interface Manifest {
  kitVersion?: unknown;
  files?: unknown;
  plugins?: unknown;
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

function versionOf(packageJson: string): string | undefined {
  const parsed = readJson(packageJson) as { version?: unknown } | undefined;
  return typeof parsed?.version === 'string' ? parsed.version : undefined;
}

function onPath(name: string, pathVar: string | undefined): string | undefined {
  for (const dir of (pathVar ?? '').split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  return undefined;
}

function walkToCliVersion(binary: string): string | undefined {
  try {
    let dir = dirname(realpathSync(binary));
    for (;;) {
      const pkg = join(dir, 'package.json');
      const parsed = readJson(pkg) as { name?: unknown } | undefined;
      if (parsed?.name === CLI_NAME) return versionOf(pkg);
      const parent = dirname(dir);
      if (parent === dir) return undefined;
      dir = parent;
    }
  } catch {
    return undefined;
  }
}

function spawnedVersion(binary: string): string | undefined {
  const result = spawnSync(binary, ['--version'], { encoding: 'utf8' });
  const match = /\d+\.\d+\.\d+\S*/.exec(result.stdout ?? '');
  return match?.[0];
}

interface Cli {
  binary: string;
  version: string;
  local: boolean;
}

/** The CLI that supplies the version and runs the sync, local first, then the PATH one. */
function findCli(
  projectDir: string,
  pathVar: string | undefined = process.env.PATH,
): Cli | undefined {
  const localPackage = join(projectDir, 'node_modules/@houserules/cli');
  const localVersion = versionOf(join(localPackage, 'package.json'));
  if (localVersion) {
    return {
      binary: join(projectDir, 'node_modules/.bin/houserules'),
      version: localVersion,
      local: true,
    };
  }
  const binary = onPath('houserules', pathVar);
  if (!binary) return undefined;
  const version = walkToCliVersion(binary) ?? spawnedVersion(binary);
  return version ? { binary, version, local: false } : undefined;
}

/** True when the install on disk disagrees with the CLI or with its own manifest. */
function isStale(projectDir: string, cliVersion: string): boolean {
  const manifest = readJson(join(projectDir, MANIFEST)) as Manifest | undefined;
  if (!manifest || typeof manifest !== 'object') return true;
  if (manifest.kitVersion !== cliVersion) return true;

  if (Array.isArray(manifest.plugins)) {
    for (const plugin of manifest.plugins as {
      name?: unknown;
      version?: unknown;
    }[]) {
      if (typeof plugin?.name !== 'string') continue;
      const installed = versionOf(
        join(projectDir, 'node_modules', plugin.name, 'package.json'),
      );
      if (installed !== undefined && installed !== plugin.version) return true;
    }
  }

  const files = manifest.files;
  if (files && typeof files === 'object') {
    for (const dest of Object.keys(files)) {
      if (!existsSync(join(projectDir, dest))) return true;
    }
  }
  return false;
}

/**
 * update-notifier's skip conditions, as doctor's `isUpdateCheckSkipped` applies them, plus the
 * config's `versionCheck: false`. CI is `CI`, `CONTINUOUS_INTEGRATION`, or any `CI_*` key,
 * unless `CI` is `0` or `false`.
 */
export function isVersionCheckSkipped(
  env: Record<string, string | undefined>,
  config: unknown,
): boolean {
  if (
    (config as { versionCheck?: unknown } | undefined)?.versionCheck === false
  )
    return true;
  if ('NO_UPDATE_NOTIFIER' in env) return true;
  if (env.NODE_ENV === 'test') return true;
  if (env.CI === '0' || env.CI === 'false') return false;
  return (
    'CI' in env ||
    'CONTINUOUS_INTEGRATION' in env ||
    Object.keys(env).some((key) => key.startsWith('CI_'))
  );
}

function releaseParts(version: string): [number, number, number] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  return match
    ? [Number(match[1]), Number(match[2]), Number(match[3])]
    : undefined;
}

/**
 * True when `latest` is a plain `x.y.z` greater than `installed`. A prerelease `latest` never
 * counts. An installed prerelease of the same `x.y.z` is behind it.
 */
export function isNewer(latest: string, installed: string): boolean {
  const target = releaseParts(latest);
  const match = /^(\d+\.\d+\.\d+)(-\S*)?$/.exec(installed);
  const current = match ? releaseParts(match[1]!) : undefined;
  if (!target || !current) return false;
  for (const [index, part] of target.entries()) {
    const installedPart = current[index]!;
    if (part !== installedPart) return part > installedPart;
  }
  return match?.[2] !== undefined;
}

/** The project's package manager by lockfile, in `detect.ts`'s order, npm when none. */
export function localManager(projectDir: string): string {
  if (existsSync(join(projectDir, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(projectDir, 'yarn.lock'))) return 'yarn';
  if (
    existsSync(join(projectDir, 'bun.lock')) ||
    existsSync(join(projectDir, 'bun.lockb'))
  )
    return 'bun';
  return 'npm';
}

/**
 * The manager whose global directory holds a PATH binary, read from its real path: a `pnpm`
 * or `.pnpm` segment is pnpm's, a `yarn` or `.yarn` segment yarn's, a `.bun` segment bun's.
 * npm when none matches.
 */
export function globalManager(binaryRealPath: string): string {
  const segments = binaryRealPath
    .split(/[\\/]/)
    .map((segment) => segment.toLowerCase());
  if (segments.some((segment) => segment === 'pnpm' || segment === '.pnpm'))
    return 'pnpm';
  if (segments.some((segment) => segment === 'yarn' || segment === '.yarn'))
    return 'yarn';
  if (segments.includes('.bun')) return 'bun';
  return 'npm';
}

type Upgrade =
  | { scope: 'local'; manager: string; isWorkspaceRoot: boolean }
  | { scope: 'global'; manager: string };

/** The command that moves `packageName` to `latest`, as doctor's `cliUpgradeCommand` builds it. */
export function upgradeCommand(packageName: string, upgrade: Upgrade): string {
  const target = `${packageName}@latest`;
  if (upgrade.scope === 'global') {
    if (upgrade.manager === 'pnpm') return `pnpm add -g ${target}`;
    if (upgrade.manager === 'yarn') return `yarn global add ${target}`;
    if (upgrade.manager === 'bun') return `bun add -g ${target}`;
    return `npm install -g ${target}`;
  }
  if (upgrade.manager === 'npm') return `npm install -D ${target}`;
  const workspaceFlag =
    upgrade.manager === 'pnpm' && upgrade.isWorkspaceRoot ? ' -w' : '';
  return `${upgrade.manager} add -D${workspaceFlag} ${target}`;
}

interface Announcement {
  version: string;
  at: string;
}

/** Mirrors `VersionCheckCache` in `@houserules/api`. */
interface VersionCheckCache {
  checkedAt: string;
  latest: Record<string, string>;
  announced?: Record<string, Announcement>;
}

/** The cache when it parses into the contract's shape, else undefined. */
export function parseCache(raw: unknown): VersionCheckCache | undefined {
  const cache = raw as Partial<VersionCheckCache> | undefined;
  if (!cache || typeof cache !== 'object') return undefined;
  if (typeof cache.checkedAt !== 'string') return undefined;
  if (!cache.latest || typeof cache.latest !== 'object') return undefined;
  return cache as VersionCheckCache;
}

/** True when the cache is missing, unparseable, or its check is a day old or more. */
export function needsCheck(
  cache: VersionCheckCache | undefined,
  now: number,
): boolean {
  if (!cache) return true;
  const checkedAt = Date.parse(cache.checkedAt);
  if (Number.isNaN(checkedAt)) return true;
  return now - checkedAt >= VERSION_CHECK_TTL_MS;
}

interface Installed {
  name: string;
  version: string;
  upgrade: Upgrade;
}

/**
 * One line per package whose cached `latest` is newer than the installed version and was not
 * announced at that version within the last day, in the order given. Returns the lines and
 * the `announced` map with each printed line recorded.
 */
export function versionNotices(
  cache: VersionCheckCache,
  installed: Installed[],
  now: number,
): { lines: string[]; announced: Record<string, Announcement> } {
  const announced = { ...(cache.announced ?? {}) };
  const lines: string[] = [];
  for (const installedPackage of installed) {
    const latest = cache.latest[installedPackage.name];
    if (
      typeof latest !== 'string' ||
      !isNewer(latest, installedPackage.version)
    )
      continue;
    const previous = announced[installedPackage.name];
    const previousAt = previous ? Date.parse(previous.at) : NaN;
    if (previous?.version === latest && now - previousAt < VERSION_CHECK_TTL_MS)
      continue;
    const label =
      installedPackage.name === CLI_NAME ? '' : `${installedPackage.name} `;
    lines.push(
      `[houserules] ${label}${latest} available (installed ${installedPackage.version}). Upgrade: ${upgradeCommand(installedPackage.name, installedPackage.upgrade)}`,
    );
    announced[installedPackage.name] = {
      version: latest,
      at: new Date(now).toISOString(),
    };
  }
  return { lines, announced };
}

function manifestPlugins(manifest: Manifest | undefined): string[] {
  if (!Array.isArray(manifest?.plugins)) return [];
  return (manifest.plugins as { name?: unknown }[])
    .map((plugin) => plugin?.name)
    .filter(
      (name): name is string =>
        typeof name === 'string' && name.startsWith(PLUGIN_SCOPE),
    );
}

/** A local CLI upgrades like the plugins. A PATH CLI upgrades globally. */
function cliUpgrade(cli: Cli, local: Upgrade): Upgrade {
  if (cli.local) return local;
  let realPath = cli.binary;
  try {
    realPath = realpathSync(cli.binary);
  } catch {
    // The PATH entry itself still names a directory.
  }
  return { scope: 'global', manager: globalManager(realPath) };
}

function installedPackages(
  projectDir: string,
  cli: Cli | undefined,
  manifest: Manifest | undefined,
): Installed[] {
  const local: Upgrade = {
    scope: 'local',
    manager: localManager(projectDir),
    isWorkspaceRoot: existsSync(join(projectDir, 'pnpm-workspace.yaml')),
  };
  const out: Installed[] = [];
  if (cli) {
    out.push({
      name: CLI_NAME,
      version: cli.version,
      upgrade: cliUpgrade(cli, local),
    });
  }
  for (const name of manifestPlugins(manifest)) {
    const version = versionOf(
      join(projectDir, 'node_modules', name, 'package.json'),
    );
    if (version) out.push({ name, version, upgrade: local });
  }
  return out;
}

function writeAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, content);
  renameSync(temp, path);
}

function spawnChecker(projectDir: string, names: string[]): void {
  const checker = join(
    dirname(fileURLToPath(import.meta.url)),
    'version-check.mjs',
  );
  if (!existsSync(checker)) return;
  const child = spawn(process.execPath, [checker, projectDir, ...names], {
    detached: true,
    stdio: 'ignore',
  });
  child.on('error', () => {});
  child.unref();
}

/** Prints each due notice and records it in the cache, so it does not repeat within the day. */
function printAndRecordNotices(
  cachePath: string,
  cache: VersionCheckCache,
  installed: Installed[],
  now: number,
): void {
  const { lines, announced } = versionNotices(cache, installed, now);
  if (lines.length === 0) return;
  for (const line of lines) console.log(line);
  try {
    writeAtomic(
      cachePath,
      JSON.stringify({ ...cache, announced }, null, 2) + '\n',
    );
  } catch {
    // An unwritable cache only means the line repeats next session.
  }
}

/** Prints the day's version notices from the cache and starts a check when it is due. */
function versionNotice(
  projectDir: string,
  cli: Cli | undefined,
  manifest: Manifest | undefined,
  now: number,
): void {
  if (isVersionCheckSkipped(process.env, readJson(join(projectDir, CONFIG))))
    return;
  const cachePath = join(projectDir, VERSION_CHECK_CACHE);
  const cache = parseCache(readJson(cachePath));
  const installed = installedPackages(projectDir, cli, manifest);
  if (cache) printAndRecordNotices(cachePath, cache, installed, now);
  if (needsCheck(cache, now)) {
    const names = [
      CLI_NAME,
      ...installed
        .map((installedPackage) => installedPackage.name)
        .filter((name) => name !== CLI_NAME),
    ];
    spawnChecker(projectDir, names);
  }
}

function main(): void {
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const cli = findCli(projectDir);
  if (!cli) console.log(INSTALL_HINT);
  else syncWhenStale(projectDir, cli);

  const parsed = readJson(join(projectDir, MANIFEST)) as Manifest | undefined;
  const manifest = parsed && typeof parsed === 'object' ? parsed : undefined;
  if (typeof manifest?.kitVersion === 'string')
    console.log(`[houserules] kit ${manifest.kitVersion}`);
  versionNotice(projectDir, cli, manifest, Date.now());
}

function syncWhenStale(projectDir: string, cli: Cli): void {
  if (!isStale(projectDir, cli.version)) return;

  const syncResult = spawnSync(cli.binary, ['update', '--sync', projectDir], {
    encoding: 'utf8',
  });
  const out = (syncResult.stdout ?? '').trim();
  if (out) console.log(out);
  if (out.split('\n').some((line) => line.startsWith('[houserules] synced'))) {
    console.log(
      '[houserules] Restart the session so the synced skills, rules, and agents load.',
    );
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
  try {
    main();
  } catch {
    // Every failure path exits 0.
  }
  process.exit(0);
}
