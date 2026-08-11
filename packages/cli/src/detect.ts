import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { execFileSync } from 'node:child_process';

import { listWorkspacePackages, readJson } from '@agent-kit/payload/workspaces';
import type {
  PackageJson,
  WorkspacePackage,
} from '@agent-kit/payload/workspaces';
import type { Ctx, KitConfig, Settings, Target } from '@agent-kit/api';
import type {
  ChangesetInvocation,
  KitManifest,
  PackageManagerInfo,
} from '@agent-kit/api/internal';

/**
 * `Ctx` and `Target` are the plugin contract and live in `@agent-kit/api`, since a plugin's
 * `plan(ctx, answers)` codes against them. The nested shapes `Ctx` is built from, such as
 * `ChangesetsState` and `PackageManagerInfo`, were never part of that contract (`plugin.ts`
 * never re-exported them either), so they cross from `@agent-kit/api/internal` instead. This
 * file stays the sole PRODUCER: `detect()` and every helper that touches the filesystem or
 * shells out to git. Re-exported here so the ~30 CLI modules that read `Ctx`/`Target` off
 * `./detect.js` need no import change.
 */
export type { Ctx, Target } from '@agent-kit/api';
export type {
  ChangesetInvocation,
  PackageManagerInfo,
} from '@agent-kit/api/internal';
// Consumed by detect()'s own return shape, not re-exported: nothing outside this file names
// them, and plugin.ts never carried them either.
import type { ChangesetsState, ClaudeState } from '@agent-kit/api/internal';

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

const MAX_PREFIX_LENGTH = 12;

export function suggestPrefix(name: string): string {
  const short = name.includes('/') ? (name.split('/').pop() ?? name) : name;
  const cleaned = short.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const prefix = cleaned.replace(/^[0-9]+/, '').slice(0, MAX_PREFIX_LENGTH);
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

let warnedGitMissing = false;

function git(root: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch (error) {
    // A non-repo dir fails with git's own exit code, not ENOENT: only the "git binary is
    // not on PATH" case is worth telling the user about, and only once per run.
    if (
      !warnedGitMissing &&
      (error as NodeJS.ErrnoException).code === 'ENOENT'
    ) {
      warnedGitMissing = true;
      console.error(
        'agent-kit: git could not be run (is it installed and on PATH?). Git-derived detection will read as "not a repo".',
      );
    }
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

/** Distinct repo-relative `file` values recorded in one ledger's JSONL entries. */
function ledgerRecordedFiles(ledgerFile: string): Set<string> {
  const files = new Set<string>();
  if (!existsSync(ledgerFile)) return files;
  let text: string;
  try {
    text = readFileSync(ledgerFile, 'utf8');
  } catch (error) {
    console.error(
      `agent-kit: could not read ${ledgerFile} (${(error as Error).message}). Treating it as having no recorded files.`,
    );
    return files;
  }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let record: { file?: unknown };
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof record.file === 'string' && record.file.includes('/')) {
      files.add(record.file);
    }
  }
  return files;
}

/**
 * Committed ledger `.jsonl` logs, which are no longer the durable record.
 *
 * They were, until the projects integration moved that role to a GitHub Project and left the
 * local file as a gitignored push queue. A repo that installed the kit before that has them
 * tracked, and `update` untracks them the same way it already untracks the rendered markdown.
 *
 * Separate from {@link trackedLedgerSurfaces} rather than folded into it, because the two mean
 * different things to the person reading the message. A committed `.md` is a generated view that
 * should never have been committed. A committed `.jsonl` was correct until the day it was not,
 * and the message has to say where the record lives now.
 *
 * Returns only what git actually tracks, so a repo that already ignores them reports nothing.
 */
export function trackedLedgerLogs(root: string, ledgerDir: string): string[] {
  return trackedFilesUnder(root, ledgerDir).filter((p) => p.endsWith('.jsonl'));
}

/**
 * Committed ledger markdown, which is a generated view of the `.jsonl` beside it.
 *
 * Covers the ledger directory and the repo root, because an install predating the move kept
 * `BACKLOG.md` and `DECISIONS.md` at the root. Returns nothing unless a ledger actually
 * exists, so a repo that keeps its own hand-written `BACKLOG.md` and has never run a ledger
 * module is never offered up for untracking.
 *
 * Nested per-area surfaces, such as `games/tower-push/BACKLOG.md`, are derived from the
 * ledger entries' own `file` field rather than a directory scan or a target's `pathPrefix`.
 * The ledger only ever records a surface the kit itself wrote, so matching against it can
 * never sweep up a user's own hand-written file at a path the kit never produced.
 */
export function trackedLedgerSurfaces(
  root: string,
  ledgerDir: string,
): string[] {
  const hasLedger = ['backlog', 'decisions'].some((name) =>
    existsSync(join(root, ledgerDir, `${name}.jsonl`)),
  );
  if (!hasLedger) return [];
  const inDir = trackedFilesUnder(root, ledgerDir).filter((p) =>
    p.endsWith('.md'),
  );
  const atRoot = (
    git(root, ['ls-files', '-c', '--', 'BACKLOG.md', 'DECISIONS.md']) ?? ''
  )
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const recorded = new Set<string>([
    ...ledgerRecordedFiles(join(root, ledgerDir, 'backlog.jsonl')),
    ...ledgerRecordedFiles(join(root, ledgerDir, 'decisions.jsonl')),
  ]);
  const nested = recorded.size
    ? (git(root, ['ls-files', '-c', '--', ...recorded]) ?? '')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
    : [];
  return [...inDir, ...atRoot, ...nested];
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

/**
 * The target repo's package manager, by `packageManager` field then lockfile.
 *
 * Exported for callers that run BEFORE `detect()` does and so cannot read the resolved
 * `Ctx`. `plugin-resolver.ts` is one: a plugin that fails to resolve aborts the run while
 * the registry is still being built.
 */
export function detectPackageManager(
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
    } catch (error) {
      console.error(
        `agent-kit: could not read .changeset/ (${(error as Error).message}). Treating pending changeset count as 0.`,
      );
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

// Config file OR dependency OR an existing ignore file. Any one of them means a
// `prettier --write .` can reach `.claude/`, which is all this needs to decide.
const PRETTIER_CONFIG_FILES = [
  '.prettierrc',
  '.prettierrc.json',
  '.prettierrc.yaml',
  '.prettierrc.yml',
  '.prettierrc.json5',
  '.prettierrc.js',
  '.prettierrc.mjs',
  '.prettierrc.cjs',
  'prettier.config.js',
  'prettier.config.mjs',
  'prettier.config.cjs',
  '.prettierignore',
];

/**
 * Whether prettier can run over this repo. The kit only writes its `.prettierignore` block
 * when the answer is yes, so a repo with no formatter never gains a config file it did not
 * ask for.
 */
function detectPrettier(root: string, rootPkg: PackageJson | null): boolean {
  if (hasDep(rootPkg, 'prettier')) return true;
  if (rootPkg?.prettier !== undefined) return true;
  return PRETTIER_CONFIG_FILES.some((name) => existsSync(join(root, name)));
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
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error(
          `agent-kit: could not list .claude/${sub} (${(error as Error).message}). Treating it as empty.`,
        );
      }
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
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error(
        `agent-kit: could not read pnpm-workspace.yaml (${(error as Error).message}). Treating catalog mode as not strict.`,
      );
    }
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
    prettier: detectPrettier(root, rootPkg),
    changesets,
    pnpmCatalogModeStrict: detectPnpmCatalogModeStrict(root),
    claude: detectClaudeState(root),
  };
}
