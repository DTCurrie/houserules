#!/usr/bin/env node
/**
 * Spawned detached by the `payload-sync` SessionStart hook. Asks the registry for the `latest`
 * dist-tag of each package named on the command line and writes the version-check cache.
 *
 * Usage: `node version-check.mjs <projectDir> <packageName>...`. Exits 0 on every path.
 */

import {
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const CACHE_PATH = '.claude/state/version-check.json';
const DEFAULT_REGISTRY = 'https://registry.npmjs.org';
const TIMEOUT_MS = 5000;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** Mirrors the doctor's `isUpdateCheckSkipped`. */
function isSkipped(env: NodeJS.ProcessEnv): boolean {
  if ('NO_UPDATE_NOTIFIER' in env) return true;
  if (env.NODE_ENV === 'test') return true;
  if (env.CI === '0' || env.CI === 'false') return false;
  return (
    'CI' in env ||
    'CONTINUOUS_INTEGRATION' in env ||
    Object.keys(env).some((key) => key.startsWith('CI_'))
  );
}

async function lookup(registry: string, name: string): Promise<string | null> {
  try {
    const url = `${registry}/-/package/${name.replaceAll('/', '%2f')}/dist-tags`;
    const response = await fetch(url, {
      headers: { 'user-agent': 'houserules', accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    const latest = (body as { latest?: unknown } | null)?.latest;
    return typeof latest === 'string' && SEMVER.test(latest) ? latest : null;
  } catch {
    return null;
  }
}

function readAnnounced(file: string): unknown {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (parsed && typeof parsed === 'object') {
      return (parsed as { announced?: unknown }).announced;
    }
  } catch {
    // Missing or unparseable: nothing to carry.
  }
  return undefined;
}

async function main(): Promise<void> {
  const [projectDir, ...names] = process.argv.slice(2);
  if (!projectDir || names.length === 0 || isSkipped(process.env)) return;
  const registry = (
    process.env.npm_config_registry || DEFAULT_REGISTRY
  ).replace(/\/+$/, '');
  const versions = await Promise.all(
    names.map(async (name) => [name, await lookup(registry, name)] as const),
  );
  const latest: Record<string, string> = {};
  for (const [name, version] of versions) if (version) latest[name] = version;
  const file = join(projectDir, CACHE_PATH);
  const announced = readAnnounced(file);
  const cache = {
    checkedAt: new Date().toISOString(),
    latest,
    ...(announced === undefined ? {} : { announced }),
  };
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(cache, null, 2)}\n`);
  renameSync(temp, file);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
  main()
    .catch(() => {
      // Every failure path exits 0.
    })
    .finally(() => process.exit(0));
}
