import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

import { globToRe } from '@houserules/payload/proc';
import type { WorkspacePackage } from '@houserules/payload/workspaces';

/**
 * True for a path whose change cannot reach a published package.
 *
 * Tests are excluded from every package's `dist` and `payload-dist` by its build tsconfig, so a
 * package whose only diff is a test ships identical bytes and needs no changeset entry. Counting
 * it produced a false positive the first time this gate ran for real: `plugin-backlog` was
 * reported as drift on the strength of a single edited test file.
 *
 * tsconfigs are excluded the same way: they configure the compiler and are not `files` entries.
 * An `exclude` edit CAN change what `dist/` emits, so this trades that rare false negative for
 * the common false positive, a repo-wide tsconfig sweep reporting every package as drift.
 */
function shipsNothing(path: string): boolean {
  return (
    /(^|\/)__tests?__\//.test(path) ||
    /\.test\.[cm]?[jt]sx?$/.test(path) ||
    /(^|\/)tsconfig[^/]*\.json$/.test(path)
  );
}

// npm packs these package-root files regardless of `files` (any case, any extension).
const ALWAYS_PACKED =
  /^(readme|license|licence|notice|copying|changelog|changes|history)(\.|$)/i;

/**
 * True for a package-root file the published tarball cannot contain.
 *
 * npm packs a root file only when `files` names it (the CLI ships CONVENTIONS.md that way) or
 * when npm always includes it (README, LICENSE, CHANGELOG and their variants, package.json, and
 * the files `main` and `bin` name).
 * Anything else at the package root, such as a CLAUDE.md or an eslint.config.js, is repo
 * tooling or documentation: it ships no bytes, so it owes no changeset entry. A `files` entry
 * is matched by exact name. A glob that happens to cover the file is the same rare false
 * negative the tsconfig exclusion above already trades for, and a package with no `files` list
 * packs everything, so its root files count.
 */
function unshippedRootFile(
  root: string,
  path: string,
  relDir: string,
): boolean {
  const name = path.startsWith(`${relDir}/`)
    ? path.slice(relDir.length + 1)
    : path;
  if (name.includes('/') || name === 'package.json' || ALWAYS_PACKED.test(name))
    return false;
  const entries = filesEntries(root, relDir);
  return (
    entries !== null &&
    !entries.includes(name) &&
    !entryPoints(root, relDir).includes(name)
  );
}

/**
 * The paths the manifest's `main` and `bin` name, without a leading `./`. npm packs each of
 * them whether or not `files` lists it.
 */
function entryPoints(root: string, relDir: string): string[] {
  const pkg = readPackageJson(root, relDir);
  const bin =
    typeof pkg?.bin === 'object' && pkg.bin !== null
      ? Object.values(pkg.bin)
      : [pkg?.bin];
  return [pkg?.main, ...bin]
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.replace(/^\.\//, ''));
}

const TOP_LEVEL_TEST_DIRECTORY = /^(tests?)\//;

/**
 * True for a path under the package's top-level `test/` or `tests/` directory that the
 * published tarball cannot contain.
 *
 * That directory holds fixtures and shared test setup, which `shipsNothing` cannot recognize by
 * name the way it does a `__tests__` directory or a `.test.` file. It ships only when `files`
 * names it or a path inside it, or when there is no `files` list and npm packs everything. A
 * source directory such as `src` is never exempt this way, because `files` names build outputs
 * and an edit there changes what `dist` emits. Entries are matched by exact name, the same
 * trade `unshippedRootFile` makes.
 */
function unshippedTestDirectory(
  root: string,
  path: string,
  relDir: string,
): boolean {
  const directory = TOP_LEVEL_TEST_DIRECTORY.exec(
    path.startsWith(`${relDir}/`) ? path.slice(relDir.length + 1) : path,
  )?.[1];
  if (!directory) return false;
  const entries = filesEntries(root, relDir);
  return (
    entries !== null &&
    !entries.some(
      (entry) => entry === directory || entry.startsWith(`${directory}/`),
    )
  );
}

/**
 * The package's `files` entries without a leading `./` or a trailing `/`, or null when it has no
 * `files` list and so packs everything.
 */
function filesEntries(root: string, relDir: string): string[] | null {
  const pkg = readPackageJson(root, relDir);
  if (!pkg || !Array.isArray(pkg.files)) return null;
  return pkg.files
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.replace(/^\.\//, '').replace(/\/$/, ''));
}

interface PackageManifest {
  files?: unknown;
  private?: unknown;
  main?: unknown;
  bin?: unknown;
}

function readPackageJson(root: string, relDir: string): PackageManifest | null {
  try {
    return JSON.parse(
      readFileSync(join(root, relDir, 'package.json'), 'utf8'),
    ) as PackageManifest;
  } catch {
    return null;
  }
}

/** The `ignore` entries of `.changeset/config.json`, empty when it is missing or malformed. */
function changesetsIgnore(root: string): string[] {
  try {
    const config = JSON.parse(
      readFileSync(join(root, '.changeset', 'config.json'), 'utf8'),
    ) as { ignore?: unknown };
    return Array.isArray(config.ignore)
      ? config.ignore.filter(
          (entry): entry is string => typeof entry === 'string',
        )
      : [];
  } catch {
    return [];
  }
}

/** Thrown when the changesets `ignore` list has entries but changesets' own matcher cannot be loaded. */
export class IgnoreMatcherUnavailableError extends Error {
  constructor(missing: string, options?: ErrorOptions) {
    super(
      [
        `Cannot match the changesets "ignore" list in .changeset/config.json: ${missing} is not resolvable from this repo.`,
        'The gate matches that list only with the matcher changesets itself uses, with no fallback.',
        'Fix: install the CLI as a root devDependency, then rerun:',
        '  pnpm add -D -w @changesets/cli   # npm: npm install -D @changesets/cli',
      ].join('\n'),
      options,
    );
    this.name = 'IgnoreMatcherUnavailableError';
  }
}

type IgnoreFilter = (names: string[], patterns: string[]) => string[];

interface PicomatchMatcher {
  (input: string): boolean;
  state: { negated: boolean };
}

type Picomatch = (
  glob: string,
  options: undefined,
  returnState: true,
) => PicomatchMatcher;

/**
 * The installed @changesets/config manifest path. A strict layout like pnpm's does not hoist it
 * to the repo root, so the lookup falls back to @changesets/cli's own module context.
 */
function changesetsConfigManifest(root: string): string {
  const fromRoot = createRequire(join(root, 'package.json'));
  try {
    return fromRoot.resolve('@changesets/config/package.json');
  } catch {
    try {
      return createRequire(
        fromRoot.resolve('@changesets/cli/package.json'),
      ).resolve('@changesets/config/package.json');
    } catch (err) {
      throw new IgnoreMatcherUnavailableError('@changesets/config', {
        cause: err,
      });
    }
  }
}

/**
 * Mirrors `globMatch` in @changesets/config 4.x: a name passes on the first positive pattern
 * that matches, and a later negated pattern it fails takes it back out.
 */
function picomatchFilter(picomatch: Picomatch): IgnoreFilter {
  return (names, patterns) => {
    const matchers = patterns.map((pattern) =>
      picomatch(pattern, undefined, true),
    );
    return names.filter((name) => {
      let isPassed = false;
      for (const matcher of matchers) {
        if (!isPassed) isPassed = !matcher.state.negated && matcher(name);
        else if (matcher.state.negated && !matcher(name)) isPassed = false;
      }
      return isPassed;
    });
  };
}

/**
 * The function the installed @changesets/config applies to its `ignore` list. 4.x calls
 * picomatch through its own `globMatch`, 3.x calls `micromatch(packageNames, ignore)`, so the
 * config package's declared dependency picks which one to load from its own module context.
 */
function loadIgnoreFilter(root: string): IgnoreFilter {
  const manifestPath = changesetsConfigManifest(root);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    dependencies?: Record<string, string>;
  };
  const matcherName =
    'picomatch' in (manifest.dependencies ?? {}) ? 'picomatch' : 'micromatch';
  let matcher: unknown;
  try {
    matcher = createRequire(manifestPath)(matcherName);
  } catch (err) {
    throw new IgnoreMatcherUnavailableError(matcherName, { cause: err });
  }
  return matcherName === 'picomatch'
    ? picomatchFilter(matcher as Picomatch)
    : (matcher as IgnoreFilter);
}

/**
 * The workspace package names changesets ignores, matched with changesets' own matcher.
 * Resolves nothing when the `ignore` list is empty.
 *
 * @throws {IgnoreMatcherUnavailableError} When the list has entries and the matcher cannot load.
 */
function ignoredPackageNames(
  root: string,
  pkgs: WorkspacePackage[],
): Set<string> {
  const ignore = changesetsIgnore(root);
  if (ignore.length === 0) return new Set();
  const filter = loadIgnoreFilter(root);
  return new Set(
    filter(
      pkgs.map((pkg) => pkg.name),
      ignore,
    ),
  );
}

/**
 * The name of the package owning `path` when its edit owes a changeset, or null when no
 * package owns it, changesets ignores the owner, the owner is private, or the path ships nothing.
 */
function gatedOwnerName(
  root: string,
  path: string,
  pkgs: WorkspacePackage[],
  ignoredPackages: Set<string>,
): string | null {
  const owner = pkgs.find(
    (pkg) => path === pkg.relDir || path.startsWith(`${pkg.relDir}/`),
  );
  if (!owner || ignoredPackages.has(owner.name)) return null;
  if (readPackageJson(root, owner.relDir)?.private === true) return null;
  const isUnshipped =
    unshippedRootFile(root, path, owner.relDir) ||
    unshippedTestDirectory(root, path, owner.relDir);
  return isUnshipped ? null : owner.name;
}

/**
 * Builds the one answer to "which package does editing this path owe a changeset to", shared
 * by the Stop-hook gate and the presence nudge so they cannot disagree.
 *
 * The returned function yields the owning package's name, or null when a `gateIgnore` glob
 * matches the path, the path ships nothing, no package owns it, changesets ignores the owner,
 * the owner is private, or the path is a package-root file or a top-level `test/` directory the
 * owner does not ship.
 *
 * @param gateIgnore The `changesets.gateIgnore` globs from the repo's houserules config.
 * @throws {IgnoreMatcherUnavailableError} When `.changeset/config.json` has `ignore` entries and
 *   changesets' own matcher is not resolvable from `root`.
 */
export function createGatedOwnerResolver(
  root: string,
  pkgs: WorkspacePackage[],
  gateIgnore: string[],
): (path: string) => string | null {
  const ignoredPath = gateIgnore.map(globToRe);
  const ignoredPackages = ignoredPackageNames(root, pkgs);
  return (path) => {
    if (ignoredPath.some((re) => re.test(path)) || shipsNothing(path))
      return null;
    return gatedOwnerName(root, path, pkgs, ignoredPackages);
  };
}
