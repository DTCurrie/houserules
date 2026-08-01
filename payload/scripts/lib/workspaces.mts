// Workspace-package enumeration without a YAML or glob dependency (claude-kit).
//
// Shared by the payload scripts (changeset-write validates --pkg names against the
// packages that actually exist) and by the installer CLI (detection) — one parser,
// so detection and validation can never disagree.
//
// Narrow but correct glob support, covering the shapes real workspace files use:
// literal dirs, trailing `*` ("packages/*"), recursive `**` ("packages/**"), and
// `!negations` (which filter the expanded set rather than expanding themselves).
// Both YAML list forms are read — block sequences and inline flow sequences.
//
// The parsers here are hand-rolled on purpose: the payload ships into user repos and
// runs on bare node, so it may not import a YAML or glob library. This is NOT a YAML
// parser — it reads one key in the shapes real workspace files use, and never throws.
// test/workspaces.test.ts pins that contract case by case.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { PackageJson } from 'type-fest';

export type { PackageJson };

export interface WorkspacePackage {
  name: string;
  /** Absolute path to the package directory. */
  dir: string;
  /** Package directory relative to the repo root, forward-slashed. */
  relDir: string;
  pkg: PackageJson;
}

/**
 * Parsed JSON, or null when the file is missing or unparseable. Defaults to
 * `PackageJson` because that is the overwhelming caller; pass `T` for the others.
 */
export function readJson<T = PackageJson>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/** Strip surrounding quotes and a trailing `# comment` from one scalar item. */
function cleanItem(raw: string): string {
  const unquoted = /^\s*(['"])([\s\S]*?)\1\s*$/.exec(raw.trim());
  if (unquoted) return unquoted[2]!.trim();
  return raw.replace(/#.*$/, '').trim();
}

// Split a flow sequence's interior on commas that are not inside quotes, so a glob
// containing a comma survives quoting.
function splitFlow(inner: string): string[] {
  const items: string[] = [];
  let current = '';
  let quote: string | null = null;
  for (const ch of inner) {
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      current += ch;
      quote = ch;
    } else if (ch === ',') {
      items.push(current);
      current = '';
    } else current += ch;
  }
  items.push(current);
  return items.map(cleanItem).filter(Boolean);
}

// Extract the `packages:` list from pnpm-workspace.yaml without a YAML parser.
// Must not be confused by sibling top-level blocks (catalog:, catalogs:,
// catalogMode:, onlyBuiltDependencies:, ...) — only lines inside the packages
// block are read, and the block ends at the next non-indented line.
//
// Both YAML list forms occur in the wild and both are read:
//   packages:            (block sequence)      packages: [a, b]   (flow sequence)
//     - packages/*
// A flow sequence may also span lines, so its interior is accumulated until `]`.
export function parsePnpmWorkspaceGlobs(yamlText: string): string[] {
  const globs: string[] = [];
  let inPackages = false;
  let flow: string | null = null;

  for (const raw of yamlText.split('\n')) {
    const line = raw.replace(/\t/g, '  ').replace(/\r$/, '');

    // Mid-flow-sequence: keep accumulating until the closing bracket.
    if (flow !== null) {
      const end = line.indexOf(']');
      flow += end === -1 ? `\n${line}` : `\n${line.slice(0, end)}`;
      if (end === -1) continue;
      globs.push(...splitFlow(flow));
      return globs;
    }

    const key = /^packages\s*:(.*)$/.exec(line);
    if (key) {
      inPackages = true;
      const inline = key[1]!.trim();
      if (!inline.startsWith('[')) continue; // block sequence follows
      const end = inline.indexOf(']');
      if (end === -1) {
        flow = inline.slice(1); // spans lines — accumulate
        continue;
      }
      globs.push(...splitFlow(inline.slice(1, end)));
      return globs;
    }

    if (!inPackages) continue;
    if (/^\S/.test(line)) break; // next top-level key ends the block
    const item = /^\s*-\s*(.+)$/.exec(line);
    if (item) {
      const value = cleanItem(item[1]!);
      if (value) globs.push(value);
    }
  }
  return globs;
}

export function workspaceGlobs(root: string): string[] {
  const yamlPath = join(root, 'pnpm-workspace.yaml');
  if (existsSync(yamlPath)) {
    try {
      return parsePnpmWorkspaceGlobs(readFileSync(yamlPath, 'utf8'));
    } catch {
      return [];
    }
  }
  const ws = readJson(join(root, 'package.json'))?.workspaces;
  if (Array.isArray(ws)) return ws;
  if (ws && Array.isArray(ws.packages)) return ws.packages;
  return [];
}

// Directories a workspace glob can never mean. Recursing into node_modules would be
// both wrong (a dependency is not a workspace member) and ruinously slow.
const SKIP_DIRS = new Set(['node_modules', '.git']);

function subdirectories(base: string): string[] {
  try {
    return readdirSync(base, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !SKIP_DIRS.has(e.name))
      .map((e) => join(base, e.name));
  } catch {
    return [];
  }
}

/** Every directory at or below `base`, excluding `base` itself. Depth-capped. */
function descendants(base: string, depth = 12): string[] {
  if (depth <= 0) return [];
  return subdirectories(base).flatMap((dir) => [
    dir,
    ...descendants(dir, depth - 1),
  ]);
}

// One positive glob → the directories it matches. `**` recurses to any depth (so a
// package nested under an intermediate directory is found); `*` matches one segment.
function expandGlob(root: string, glob: string): string[] {
  const clean = glob.trim().replace(/\/+$/, '');
  if (!clean || clean.startsWith('!')) return [];
  if (clean.endsWith('/**')) return descendants(join(root, clean.slice(0, -3)));
  if (clean.endsWith('/*'))
    return subdirectories(join(root, clean.slice(0, -2)));
  const dir = join(root, clean);
  try {
    if (statSync(dir).isDirectory()) return [dir];
  } catch {
    /* not a dir */
  }
  return [];
}

// A `!glob` compiled to a matcher over root-relative, forward-slashed paths.
// `**` spans separators, `*` does not; every other character is literal.
function negationMatcher(glob: string): (relDir: string) => boolean {
  const pattern = glob
    .trim()
    .replace(/^!/, '')
    .replace(/\/+$/, '')
    .split('/')
    .map((segment) =>
      segment === '**'
        ? '.*'
        : segment.replace(/[.+^${}()|[\]\\]/g, '\\$&').replaceAll('*', '[^/]*'),
    )
    .join('/');
  // A negated directory excludes everything beneath it, not just the dir itself.
  const re = new RegExp(`^${pattern}(?:/.*)?$`);
  return (relDir) => re.test(relDir);
}

// → [{ name, dir, relDir, pkg }] for every workspace member that has a named
// package.json. Empty scaffold dirs (a bare .gitkeep) are silently skipped.
//
// `!globs` are EXCLUSIONS, not patterns to expand: they filter the set the positive
// globs produced, which is why they are applied here rather than in expandGlob.
export function listWorkspacePackages(root: string): WorkspacePackage[] {
  const globs = workspaceGlobs(root);
  const excluded = globs
    .filter((g) => g.trim().startsWith('!'))
    .map(negationMatcher);

  const seen = new Set<string>();
  const out: WorkspacePackage[] = [];
  for (const glob of globs) {
    for (const dir of expandGlob(root, glob)) {
      if (seen.has(dir)) continue;
      seen.add(dir);
      const relDir = relative(root, dir).replaceAll('\\', '/');
      if (excluded.some((matches) => matches(relDir))) continue;
      const pkg = readJson(join(dir, 'package.json'));
      if (!pkg?.name) continue;
      out.push({ name: pkg.name, dir, relDir, pkg });
    }
  }
  return out;
}

// All valid --pkg names for changeset-write: workspace members, or for a
// single-package repo the root package itself.
export function listPublishablePackageNames(root: string): string[] {
  const members = listWorkspacePackages(root);
  if (members.length) return members.map((m) => m.name);
  const rootPkg = readJson(join(root, 'package.json'));
  return rootPkg?.name ? [rootPkg.name] : [];
}
