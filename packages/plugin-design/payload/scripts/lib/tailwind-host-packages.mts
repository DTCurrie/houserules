import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { isRecord } from './is-record.mjs';

/**
 * A no-throw outcome, the same shape `SessionResult` uses in `cdp-session.mts`. Every entry
 * point here reports a missing or wrong-version package as a sentence a reader can act on,
 * never as a thrown error from inside a payload script.
 */
export type TailwindResult<TValue> =
  { ok: true; value: TValue } | { ok: false; error: string };

export const TAILWIND_PACKAGE = 'tailwindcss';
export const OXIDE_PACKAGE = '@tailwindcss/oxide';

/** The plugin supports Tailwind v4 only, matching what `design.mjs extract` already reports. */
const SUPPORTED_TAILWIND_MAJOR = 4;

export interface HostPackage {
  /** Absolute path to the package directory inside the host repo. */
  directory: string;
  /** File URL of the module `import()` can load. Never a bare specifier. */
  entryModuleUrl: string;
  version: string;
}

interface PackageManifest {
  version?: string;
  main?: string;
  module?: string;
  exports?: unknown;
}

/**
 * The relative path of the module `import()` should load.
 *
 * `tailwindcss` maps `.` to a conditional object whose `require` entry is CJS, and importing that
 * CJS entry yields `__unstable__loadDesignSystem: undefined` rather than throwing. The `import`
 * condition is the only usable one. `@tailwindcss/oxide` ships no `exports` field at all, so it
 * falls through to `main`.
 */
function importEntryOf(manifest: PackageManifest): string | undefined {
  const root = isRecord(manifest.exports)
    ? manifest.exports['.']
    : manifest.exports;
  if (typeof root === 'string') return root;
  if (isRecord(root)) {
    const condition = root.import ?? root.default;
    if (typeof condition === 'string') return condition;
  }
  return manifest.module ?? manifest.main;
}

/**
 * The dev-install command for `root`'s package manager, by lockfile.
 *
 * Lockfile only, deliberately. The installer's `detectPackageManager` prefers
 * `package.json`'s `packageManager` field first, but it is not reachable here: this is a
 * copied payload lib running on bare node, and it may not import from the CLI's `src/`. A
 * lockfile is strong evidence on its own, and npm is the right fallback when there is none.
 */
function installHint(root: string, packageName: string): string {
  const spec = `${packageName}@${SUPPORTED_TAILWIND_MAJOR}`;
  if (existsSync(join(root, 'pnpm-lock.yaml')))
    return `Install it in that repo with \`pnpm add -D ${spec}\`.`;
  if (existsSync(join(root, 'yarn.lock')))
    return `Install it in that repo with \`yarn add -D ${spec}\`.`;
  if (existsSync(join(root, 'bun.lock')) || existsSync(join(root, 'bun.lockb')))
    return `Install it in that repo with \`bun add -d ${spec}\`.`;
  return `Install it in that repo with \`npm install -D ${spec}\`.`;
}

function readManifest(path: string): TailwindResult<PackageManifest> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!isRecord(parsed))
      return { ok: false, error: `${path} is not an object.` };
    return { ok: true, value: parsed as PackageManifest };
  } catch (error) {
    return {
      ok: false,
      error: `${path} could not be read: ${(error as Error).message}`,
    };
  }
}

/**
 * Walks `node_modules` upward from `root` looking for a package's manifest.
 *
 * Deliberately not `createRequire(root).resolve(...)`, which also searches `NODE_PATH` and node's
 * global folders. A repo with no Tailwind then resolves whichever copy those point at, and the
 * false positive is not test-only: any host repo run from a `NODE_PATH`-polluted shell gets the
 * same wrong answer. The CLI's `payload/__tests__/execution.test.ts` strips `NODE_PATH` for this
 * reason. `src/tailwind-check.ts` holds the CLI-side copy of this walk, since `src/` may not
 * import from `payload/`.
 */
function findPackageManifest(
  root: string,
  packageName: string,
): string | undefined {
  let directory = resolve(root);
  for (;;) {
    const candidate = join(
      directory,
      'node_modules',
      packageName,
      'package.json',
    );
    if (existsSync(candidate)) return candidate;
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

/**
 * Locates one of the host repo's own Tailwind packages, without importing it.
 *
 * Resolution is anchored at `root` rather than at this file, so the answer is the target repo's
 * copy and not whichever copy happens to sit above the installed script. That is also what makes
 * the behavior testable against a fixture whose `node_modules` differs from this package's.
 *
 * @returns The package directory, its version, and a file URL to import. A missing package, an
 * unreadable manifest, and an unsupported major version are all `ok: false` with the fix in the
 * message.
 */
export function resolveHostPackage(
  root: string,
  packageName: string,
): TailwindResult<HostPackage> {
  const manifestPath = findPackageManifest(root, packageName);
  if (manifestPath === undefined) {
    return {
      ok: false,
      error: `${packageName} is not installed in ${root}. ${installHint(root, packageName)}`,
    };
  }

  const manifest = readManifest(manifestPath);
  if (!manifest.ok) return manifest;

  const version = manifest.value.version;
  if (typeof version !== 'string') {
    return {
      ok: false,
      error: `${packageName} at ${manifestPath} declares no version.`,
    };
  }
  const major = Number.parseInt(version, 10);
  if (major !== SUPPORTED_TAILWIND_MAJOR) {
    return {
      ok: false,
      error: `${packageName} is version ${version}, and this plugin supports major ${SUPPORTED_TAILWIND_MAJOR} only.`,
    };
  }

  const entry = importEntryOf(manifest.value);
  if (entry === undefined) {
    return {
      ok: false,
      error: `${packageName} ${version} declares no importable entry in ${manifestPath}.`,
    };
  }

  const directory = dirname(manifestPath);
  return {
    ok: true,
    value: {
      directory,
      entryModuleUrl: pathToFileURL(join(directory, entry)).href,
      version,
    },
  };
}
