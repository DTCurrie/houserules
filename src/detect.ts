import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  listWorkspacePackages,
  readJson,
} from '../payload-dist/scripts/lib/workspaces.mjs';
import type {
  PackageJson,
  WorkspacePackage,
} from '../payload-dist/scripts/lib/workspaces.mjs';
import type { KitConfig, KitConfigTarget } from './core/config.js';
import type { KitManifest } from './core/manifest.js';
import type { Settings } from './merge-settings.js';

/** How the package manager was identified. Shown in the profile card. */
export type PackageManagerSource = 'packageManager' | 'lockfile' | 'default';

export interface PackageManagerInfo {
  name: string;
  version?: string;
  source: PackageManagerSource;
}

/**
 * A unit of the repo the kit tracks: a workspace package, or the repo itself for a
 * single-package repo. Detection proposes these. `kit.config.json` is the contract
 * once the user has edited it.
 *
 * It is deliberately the SAME type as a config target rather than a near-duplicate.
 * `update`/`modules` prefer `kitConfig.targets` and fall back to detection's, so the
 * two are used interchangeably. Declaring them separately only invited them to
 * drift on optionality. Per-field documentation lives on the zod schema's
 * `.describe()` calls in `core/config.ts`.
 */
export type Target = KitConfigTarget;

export type ChangesetInvocation =
  'devdep' | 'root-script' | 'external-cli' | 'absent';

export interface ChangesetsState {
  configExists: boolean;
  config: Record<string, unknown> | null;
  pendingCount: number;
  devDep: boolean;
  rootScript: string | null;
  invocation: ChangesetInvocation;
  baseBranch: string;
}

export interface GitState {
  isRepo: boolean;
  top: string | null;
  hasCommits: boolean;
  branch: string | null;
}

export interface ClaudeState {
  dirExists: boolean;
  settingsExists: boolean;
  settings: Settings | null;
  /** Message from a failed settings.json parse. Null when it parsed or is absent. */
  settingsParseError: string | null;
  settingsLocalExists: boolean;
  claudeMdExists: boolean;
  manifest: KitManifest | null;
  kitConfig: KitConfig | null;
  agents: string[];
  skills: string[];
}

/** Everything `detect()` concluded, read-only. The sole input to module decisions. */
export interface Ctx {
  root: string;
  git: GitState;
  packageManager: PackageManagerInfo | null;
  rootPkg: PackageJson | null;
  isMonorepo: boolean;
  packages: WorkspacePackage[];
  targets: Target[];
  typescript: boolean;
  changesets: ChangesetsState;
  pnpmCatalogModeStrict: boolean;
  claude: ClaudeState;
}

// `prettier --write` writes but `prettier --check` only verifies. Wiring a checker
// into the auto-fix hook would fail unfixably on every stop.
function isWriteFormatScript(cmd: unknown): boolean {
  if (typeof cmd !== 'string') return false;
  if (/--check\b|--list-different\b/.test(cmd)) return false;
  return /--write\b|(?:^|\s)-w\b/.test(cmd);
}

type ScriptsBag = Record<string, string | undefined>;

/**
 * Picks the package.json scripts that WRITE fixes. A unified `fix` script wins, because
 * repos like wireit monorepos wire lint:fix and format:fix underneath it and running the
 * parts too would duplicate work. Otherwise takes the lint and format writers that
 * exist, never a bare or `--check` `format`.
 *
 * @returns The script names in run order, or null when the package has no fixer.
 */
export function detectFixCommands(scripts: ScriptsBag = {}): string[] | null {
  if (typeof scripts.fix === 'string') return ['fix'];

  const out: string[] = [];
  if (typeof scripts['lint:fix'] === 'string') out.push('lint:fix');
  if (typeof scripts['format:fix'] === 'string') out.push('format:fix');
  else if (isWriteFormatScript(scripts.format)) out.push('format');

  return out.length ? out : null;
}

/**
 * Picks the read-only gate scripts, never a fixer. A unified `verify` script wins,
 * because repos wire the parts underneath it. Otherwise takes the checkers that exist,
 * in the order typecheck or check, then test, then lint.
 *
 * @returns The script names in run order, or null when the package has no checker.
 */
export function detectVerifyCommands(
  scripts: ScriptsBag = {},
): string[] | null {
  if (typeof scripts.verify === 'string') return ['verify'];

  const out: string[] = [];
  if (typeof scripts.typecheck === 'string') out.push('typecheck');
  else if (typeof scripts.check === 'string') out.push('check');
  if (typeof scripts.test === 'string') out.push('test');
  if (typeof scripts.lint === 'string') out.push('lint');

  return out.length ? out : null;
}

export function suggestPrefix(name: string): string {
  const short = name.includes('/') ? (name.split('/').pop() ?? name) : name;
  const cleaned = short.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const prefix = cleaned.replace(/^[0-9]+/, '').slice(0, 12);
  return prefix || 'PKG';
}

function titleCase(s: string): string {
  return s
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

function shortName(pkgName: string | undefined, dir: string): string {
  const short = pkgName?.includes('/') ? pkgName.split('/').pop() : pkgName;
  return (short || basename(dir)).toLowerCase().replace(/[^a-z0-9-]/g, '-');
}

function git(root: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

// The directory's own .gitignore is excluded: it stays committed so the intent travels
// with the repo. Empty on any git failure or non-repo.
function trackedFilesUnder(root: string, dir: string): string[] {
  const out = git(root, ['ls-files', '-c', '--', dir]);
  if (!out) return [];
  const ownGitignore = `${dir}/.gitignore`;
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter((p) => p && p !== ownGitignore);
}

/** Committed reference templates from installs that predate the self-gitignore. */
export function trackedTemplateFiles(root: string): string[] {
  return trackedFilesUnder(root, '.claude/kit-templates');
}

/** Committed hook scripts from installs that predate the self-gitignore. */
export function trackedScriptFiles(root: string): string[] {
  return trackedFilesUnder(root, '.claude/scripts');
}

/**
 * Drops paths from the git index only. Working-tree copies stay on disk and the removal
 * is staged, never committed, because the user owns commits. Git failures are swallowed
 * so callers never crash on unexpected repo state.
 *
 * @returns False when git refused the removal.
 */
export function untrackFromIndex(root: string, files: string[]): boolean {
  if (!files.length) return true;
  return git(root, ['rm', '--cached', '-f', '-q', '--', ...files]) !== null;
}

function detectPackageManager(
  root: string,
  rootPkg: PackageJson | null,
): PackageManagerInfo | null {
  const pmField = rootPkg?.packageManager;
  if (typeof pmField === 'string' && pmField.includes('@')) {
    const at = pmField.lastIndexOf('@');
    return {
      name: pmField.slice(0, at),
      version: pmField.slice(at + 1),
      source: 'packageManager',
    };
  }
  if (existsSync(join(root, 'pnpm-lock.yaml')))
    return { name: 'pnpm', source: 'lockfile' };
  if (existsSync(join(root, 'yarn.lock')))
    return { name: 'yarn', source: 'lockfile' };
  if (existsSync(join(root, 'bun.lock')) || existsSync(join(root, 'bun.lockb')))
    return { name: 'bun', source: 'lockfile' };
  if (existsSync(join(root, 'package-lock.json')))
    return { name: 'npm', source: 'lockfile' };
  return rootPkg ? { name: 'npm', source: 'default' } : null;
}

function hasDep(pkg: PackageJson | null | undefined, name: string): boolean {
  return Boolean(pkg?.dependencies?.[name] || pkg?.devDependencies?.[name]);
}

function detectChangesets(
  root: string,
  rootPkg: PackageJson | null,
): ChangesetsState {
  const configPath = join(root, '.changeset', 'config.json');
  const configExists = existsSync(configPath);
  const config = configExists
    ? readJson<Record<string, unknown>>(configPath)
    : null;
  let pendingCount = 0;
  if (existsSync(join(root, '.changeset'))) {
    try {
      pendingCount = readdirSync(join(root, '.changeset')).filter(
        (f) => f.endsWith('.md') && f.toLowerCase() !== 'readme.md',
      ).length;
    } catch {
      /* unreadable. Treat as none */
    }
  }
  const devDep = hasDep(rootPkg, '@changesets/cli');
  const scriptEntry = Object.entries(rootPkg?.scripts ?? {}).find(
    ([, cmd]) =>
      typeof cmd === 'string' &&
      /(^|[\s/])(changeset|@changesets\/cli)\b/.test(cmd),
  );
  const invocation: ChangesetInvocation = devDep
    ? 'devdep'
    : scriptEntry
      ? 'root-script'
      : configExists
        ? 'external-cli'
        : 'absent';
  return {
    configExists,
    config,
    pendingCount,
    devDep,
    rootScript: scriptEntry ? scriptEntry[0] : null,
    invocation,
    baseBranch:
      typeof config?.baseBranch === 'string' ? config.baseBranch : 'main',
  };
}

function detectTypescript(
  root: string,
  rootPkg: PackageJson | null,
  packages: WorkspacePackage[],
): boolean {
  if (hasDep(rootPkg, 'typescript')) return true;
  if (existsSync(join(root, 'tsconfig.json'))) return true;
  return packages.some(
    (p) =>
      hasDep(p.pkg, 'typescript') || existsSync(join(p.dir, 'tsconfig.json')),
  );
}

function buildTargets(
  root: string,
  rootPkg: PackageJson | null,
  packages: WorkspacePackage[],
): Target[] {
  if (packages.length) {
    return packages.map((p) => {
      const name = shortName(p.name, p.dir);
      return {
        name,
        prefix: suggestPrefix(p.name),
        packageName: p.name,
        pathPrefix: `${p.relDir}/`,
        sourcePath: existsSync(join(p.dir, 'src'))
          ? `${p.relDir}/src`
          : p.relDir,
        label: titleCase(name),
        fixCommands: detectFixCommands(p.pkg.scripts),
        verifyCommands: detectVerifyCommands(p.pkg.scripts),
      };
    });
  }
  if (rootPkg) {
    const name = shortName(rootPkg.name, root);
    return [
      {
        name,
        prefix: suggestPrefix(rootPkg.name ?? basename(root)),
        packageName: rootPkg.name ?? '.',
        pathPrefix: '',
        sourcePath: existsSync(join(root, 'src')) ? 'src' : '',
        label: titleCase(name),
        fixCommands: detectFixCommands(rootPkg.scripts),
        verifyCommands: detectVerifyCommands(rootPkg.scripts),
      },
    ];
  }
  return [];
}

function detectClaudeState(root: string): ClaudeState {
  const dir = join(root, '.claude');
  const settingsPath = join(dir, 'settings.json');
  let settings: Settings | null = null;
  let settingsParseError: string | null = null;
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    } catch (e) {
      settingsParseError = e instanceof Error ? e.message : String(e);
    }
  }
  const listNames = (sub: string): string[] => {
    try {
      return readdirSync(join(dir, sub)).filter((f) => !f.startsWith('.'));
    } catch {
      return [];
    }
  };
  return {
    dirExists: existsSync(dir),
    settingsExists: existsSync(settingsPath),
    settings,
    settingsParseError,
    settingsLocalExists: existsSync(join(dir, 'settings.local.json')),
    claudeMdExists: existsSync(join(root, 'CLAUDE.md')),
    manifest: readJson<KitManifest>(join(dir, 'kit-manifest.json')),
    kitConfig: readJson<KitConfig>(join(dir, 'kit.config.json')),
    agents: listNames('agents'),
    skills: listNames('skills'),
  };
}

function detectPnpmCatalogModeStrict(root: string): boolean {
  try {
    return /^catalogMode:\s*strict\b/m.test(
      readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8'),
    );
  } catch {
    return false;
  }
}

/**
 * Profiles a repo into the `ctx` every module's `defaultEnabled()` and `plan()` decides
 * from. Read-only: nothing in this file may write.
 */
export function detect(root: string): Ctx {
  const gitTop = git(root, ['rev-parse', '--show-toplevel']);
  const rootPkg = readJson(join(root, 'package.json'));
  const packages = listWorkspacePackages(root);
  const changesets = detectChangesets(root, rootPkg);

  return {
    root,
    git: {
      isRepo: Boolean(gitTop),
      top: gitTop,
      hasCommits: git(root, ['rev-parse', '--verify', 'HEAD']) !== null,
      branch: git(root, ['rev-parse', '--abbrev-ref', 'HEAD']),
    },
    packageManager: detectPackageManager(root, rootPkg),
    rootPkg,
    isMonorepo: packages.length > 0,
    packages,
    targets: buildTargets(root, rootPkg, packages),
    typescript: detectTypescript(root, rootPkg, packages),
    changesets,
    pnpmCatalogModeStrict: detectPnpmCatalogModeStrict(root),
    claude: detectClaudeState(root),
  };
}
