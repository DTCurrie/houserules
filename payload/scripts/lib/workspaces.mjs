// Workspace-package enumeration without a YAML or glob dependency (claude-kit).
//
// Shared by the payload scripts (changeset-write validates --pkg names against the
// packages that actually exist) and by the installer CLI (detection) — one parser,
// so detection and validation can never disagree.
//
// Deliberately narrow glob support: literal dirs and single trailing-* segments
// ("packages/*", "apps/*") — the shapes real workspace files use. `!negations`
// are ignored; `dir/**` degrades to `dir/*`.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

export function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

// Extract the `packages:` list from pnpm-workspace.yaml without a YAML parser.
// Must not be confused by sibling top-level blocks (catalog:, catalogs:,
// catalogMode:, onlyBuiltDependencies:, ...) — only lines inside the packages
// block are read, and the block ends at the next non-indented line.
export function parsePnpmWorkspaceGlobs(yamlText) {
  const globs = [];
  let inPackages = false;
  for (const raw of yamlText.split('\n')) {
    const line = raw.replace(/\t/g, '  ');
    if (/^packages\s*:/.test(line)) {
      inPackages = true;
      continue;
    }
    if (!inPackages) continue;
    if (/^\S/.test(line)) break;
    const m = line.match(/^\s*-\s*(['"]?)([^'"#\n]+)\1/);
    if (m) globs.push(m[2].trim());
  }
  return globs;
}

export function workspaceGlobs(root) {
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

function expandGlob(root, glob) {
  const clean = glob.trim().replace(/\/+$/, '');
  if (!clean || clean.startsWith('!')) return [];
  if (clean.endsWith('/**')) return expandGlob(root, `${clean.slice(0, -3)}/*`);
  if (clean.endsWith('/*')) {
    const base = join(root, clean.slice(0, -2));
    let entries;
    try {
      entries = readdirSync(base, { withFileTypes: true });
    } catch {
      return [];
    }
    return entries.filter((e) => e.isDirectory()).map((e) => join(base, e.name));
  }
  const dir = join(root, clean);
  try {
    if (statSync(dir).isDirectory()) return [dir];
  } catch {
    /* not a dir */
  }
  return [];
}

// → [{ name, dir, relDir, pkg }] for every workspace member that has a named
// package.json. Empty scaffold dirs (a bare .gitkeep) are silently skipped.
export function listWorkspacePackages(root) {
  const seen = new Set();
  const out = [];
  for (const glob of workspaceGlobs(root)) {
    for (const dir of expandGlob(root, glob)) {
      if (seen.has(dir)) continue;
      seen.add(dir);
      const pkg = readJson(join(dir, 'package.json'));
      if (!pkg?.name) continue;
      out.push({ name: pkg.name, dir, relDir: relative(root, dir).replaceAll('\\', '/'), pkg });
    }
  }
  return out;
}

// All valid --pkg names for changeset-write: workspace members, or for a
// single-package repo the root package itself.
export function listPublishablePackageNames(root) {
  const members = listWorkspacePackages(root);
  if (members.length) return members.map((m) => m.name);
  const rootPkg = readJson(join(root, 'package.json'));
  return rootPkg?.name ? [rootPkg.name] : [];
}
