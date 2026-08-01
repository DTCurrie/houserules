// Read-only repo profiling (claude-kit CLI). Produces the `ctx` every module's
// defaultEnabled()/plan() decides from. NOTHING in this file may write.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  listWorkspacePackages,
  readJson,
} from '../payload-dist/scripts/lib/workspaces.mjs';
import type {
  ChangesetInvocation,
  ChangesetsState,
  ClaudeState,
  Ctx,
  KitConfig,
  KitManifest,
  PackageJson,
  PackageManagerInfo,
  Settings,
  Target,
  WorkspacePackage,
} from './types.js';

// A `format` script is ambiguous — `prettier --write` writes, `prettier --check`
// only verifies. Treat it as a fixer ONLY when it clearly writes, so the auto-fix
// hook never wires a checker (which would fail unfixably on every stop).
function isWriteFormatScript(cmd: unknown): boolean {
  if (typeof cmd !== 'string') return false;
  if (/--check\b|--list-different\b/.test(cmd)) return false;
  return /--write\b|(?:^|\s)-w\b/.test(cmd);
}

type ScriptsBag = Record<string, string | undefined>;

// Fix-script detection. A unified `fix` script wins (repos like wireit monorepos
// wire lint:fix+format:fix underneath it — running the parts too would duplicate
// work). Otherwise take the lint + format writers that exist: `format:fix` when
// present, else a `format` script that clearly WRITES (never a bare/check `format`).
export function detectFixCommands(scripts: ScriptsBag = {}): string[] | null {
  if (typeof scripts.fix === 'string') return ['fix'];

  const out: string[] = [];
  if (typeof scripts['lint:fix'] === 'string') out.push('lint:fix');
  if (typeof scripts['format:fix'] === 'string') out.push('format:fix');
  else if (isWriteFormatScript(scripts.format)) out.push('format');

  return out.length ? out : null;
}

// Verify-command detection (the read-only gate: check/test/lint, never a fixer).
// A unified `verify` script wins (repos wire the parts underneath it). Otherwise
// take the checkers that exist — typecheck|check, test, lint — in that order.
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

// Files under a self-gitignored kit directory that git still tracks. The
// directory's own .gitignore is deliberately excluded — it stays committed so the
// intent travels with the repo. Non-empty only for installs that committed the
// directory's contents before the kit began ignoring them; empty on any git
// failure or non-repo.
function trackedFilesUnder(root: string, dir: string): string[] {
  const out = git(root, ['ls-files', '-c', '--', dir]);
  if (!out) return [];
  const ownGitignore = `${dir}/.gitignore`;
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter((p) => p && p !== ownGitignore);
}

export function trackedTemplateFiles(root: string): string[] {
  return trackedFilesUnder(root, '.claude/kit-templates');
}

export function trackedScriptFiles(root: string): string[] {
  return trackedFilesUnder(root, '.claude/scripts');
}

// Drop paths from the git index only — working-tree copies stay on disk and the
// removal is staged, not committed (the user owns commits). Swallows git
// failures so callers never crash on unexpected repo state.
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
      /* unreadable — treat as none */
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
