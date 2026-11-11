import { readFileSync } from 'node:fs';
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
 * when npm always includes it (README, LICENSE, CHANGELOG and their variants, and package.json).
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
  return entries !== null && !entries.includes(name);
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

function readPackageJson(
  root: string,
  relDir: string,
): { files?: unknown; private?: unknown } | null {
  try {
    return JSON.parse(
      readFileSync(join(root, relDir, 'package.json'), 'utf8'),
    ) as { files?: unknown; private?: unknown };
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

/**
 * The name of the package owning `path` when its edit owes a changeset, or null when no
 * package owns it, changesets ignores the owner, the owner is private, or the path ships nothing.
 */
function gatedOwnerName(
  root: string,
  path: string,
  pkgs: WorkspacePackage[],
  ignoredPackage: RegExp[],
): string | null {
  const owner = pkgs.find(
    (pkg) => path === pkg.relDir || path.startsWith(`${pkg.relDir}/`),
  );
  if (!owner || ignoredPackage.some((re) => re.test(owner.name))) return null;
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
 */
export function createGatedOwnerResolver(
  root: string,
  pkgs: WorkspacePackage[],
  gateIgnore: string[],
): (path: string) => string | null {
  const ignoredPath = gateIgnore.map(globToRe);
  const ignoredPackage = changesetsIgnore(root).map(globToRe);
  return (path) => {
    if (ignoredPath.some((re) => re.test(path)) || shipsNothing(path))
      return null;
    return gatedOwnerName(root, path, pkgs, ignoredPackage);
  };
}
