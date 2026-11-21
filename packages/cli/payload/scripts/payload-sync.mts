#!/usr/bin/env node
/**
 * SessionStart hook. Brings a stale or incomplete install back in line with the installed
 * CLI: when the manifest, the CLI version, a plugin version, or a recorded file disagrees
 * with what is on disk, it runs the CLI's `update --sync`.
 *
 * It reads small files only and spawns nothing on a current install with a local CLI.
 * Every path exits 0. Node builtins only, since it runs standalone in a user's repo.
 */

import {
  accessSync,
  constants,
  existsSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const MANIFEST = '.claude/houserules.manifest.json';
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

function main(): void {
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const cli = findCli(projectDir);
  if (!cli) {
    console.log(INSTALL_HINT);
    return;
  }
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
