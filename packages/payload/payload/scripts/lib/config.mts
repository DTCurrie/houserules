import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { findRepoRoot, repoRoot } from './proc.mjs';

export interface RunnerBlock {
  runner?: string | undefined;
  filterFlag?: string | undefined;
  runScriptPrefix?: string[] | undefined;
  commands?: string[] | undefined;
  /** `fix` only: run the fixer when a subagent stops. */
  onSubagentStop?: boolean | undefined;
  /** `fix` only: per-command file extensions, e.g. {"lint:fix": ["ts","tsx"]}. */
  commandExtensions?: Record<string, string[]> | undefined;
  /** `fix` only: append the turn's changed paths to each fix command after `--`. Off by default. */
  passPaths?: boolean | undefined;
  /** `verify` only: branch the changed-file diff is taken against. */
  baseBranch?: string | undefined;
  /** `verify` only: per-command wall-clock cap in milliseconds. Unset means no cap. */
  timeoutMs?: number | undefined;
  /** `verify` only: a command template that tests only the files `--paths` names. Unset means package-level. */
  relatedCommand?: string | undefined;
  /** `verify` only: `false` runs the `--run` jobs one at a time. Unset or `true` runs independent packages together. */
  concurrent?: boolean | undefined;
  /** `verify` only: root `package.json` scripts run at the repo root after every package job when a monorepo scope is non-empty. */
  rootCommands?: string[] | undefined;
}

export interface ConfigTarget {
  name: string;
  prefix?: string;
  packageName?: string;
  pathPrefix?: string;
  sourcePath?: string;
  label?: string;
  fixCommands?: string[] | null;
  verifyCommands?: string[] | null;
  changelogPath?: string;
  logPath?: string;
  regen?: { sourceGlob?: string; command?: string };
}

/**
 * The shape the hooks read, typed loosely on purpose. `src/core/config.ts` holds the
 * strict zod schema and is the authority on what a valid houserules.config.json looks like. This
 * reader is the other half of that split. It runs inside a user's repo with no
 * dependencies and has to cope with a config the schema would reject outright, because a
 * hook that dies on a bad config is noise on every tool call. Every field is therefore
 * optional and callers default rather than assume.
 *
 * The two cannot be one type. The payload compiles with `rootDir=payload` and can never
 * import from `src/`, which would drag zod into a user's repo.
 */
export interface HouseConfig {
  version?: number;
  packageManager?: string;
  fix?: RunnerBlock;
  verify?: RunnerBlock;
  lintableExtensions?: string[];
  generatedFilePattern?: string;
  guard?: {
    gitCommit?: boolean;
    gitPush?: boolean;
    gitStash?: boolean;
    gitDiscard?: boolean;
    prCreate?: boolean;
    custom?: { pattern: string; message: string }[];
  };
  changesets?: {
    enabled?: boolean;
    stopCheck?: boolean;
    baseBranch?: string;
    /** Repo-relative path globs the Stop-hook changeset gate never counts. */
    gateIgnore?: string[];
  };
  ledger?: { enabled?: boolean };
  ledgers?: { dir?: string };
  readGuard?: { enabled?: boolean; maxBytes?: number; denyGlobs?: string[] };
  claudeMd?: { managed?: boolean };
  /** Which file carries the houserules block. Unset honors the file the repo already has. */
  instructionsFile?: 'CLAUDE.md' | 'AGENTS.md';
  /** Read by the design plugin's `design.mjs`: the stylesheet Tailwind compiles, repo-root-relative. */
  design?: { themeEntry?: string };
  /** `maxWorkers` is read by `wave-ceiling.mjs`: the per-wave worker ceiling, overriding the machine-derived one. */
  orchestrate?: {
    workerTools?: string[];
    maxWorkers?: number;
    fileLevelAcceptance?: boolean;
  };
  targets: ConfigTarget[];
  [key: string]: unknown;
}

/** What `filterFlag` means when a runner block omits it: a workspace, filtered per package. */
export const DEFAULT_FILTER_FLAG = '--filter';

/**
 * The commands that actually run for one target, from its own override and the block's list.
 *
 * `null` and `undefined` are different answers, which is why this is not a bare `??`. An
 * absent override inherits the block's commands. An explicit `null` means this target has
 * none, the escape hatch for a package the runner should skip entirely.
 */
export function resolveTargetCommands(
  override: string[] | null | undefined,
  blockCommands: string[] | undefined,
): string[] {
  if (override === null) return [];
  return override ?? blockCommands ?? [];
}

/**
 * Whether a runner block's commands run as REPO-ROOT scripts rather than once per package.
 *
 * An empty `filterFlag` is how a single-package repo, or a workspace whose lint and format
 * live at the root, is spelled. Both runners drop the package name from the argv in that
 * shape, so the script that has to exist is the ROOT one no matter which target contributed
 * the command.
 */
export function runsAtRepoRoot(block: RunnerBlock | undefined): boolean {
  return !(block?.filterFlag ?? DEFAULT_FILTER_FLAG);
}

export { repoRoot };

/**
 * `repoRoot()` without the cwd fallback. Returns null outside a git work tree, or when `git`
 * is absent, so a script can tell a missing repo apart from a repo rooted at the cwd.
 *
 * A runtime-invoked payload script is required to exit 0 on every failure path. Such a
 * script resolves its root through this and exits cleanly on null.
 */
export function repoRootSafe(): string | null {
  return findRepoRoot();
}

/**
 * `repoRoot()` for a script that must refuse to run outside a git work tree, such as one that
 * writes ledgers or changelogs keyed to the repo.
 *
 * @throws Error naming the cwd when it is outside every work tree or git cannot answer.
 */
export function requireRepoRoot(): string {
  const root = findRepoRoot();
  if (root === null) {
    throw new Error(
      `houserules: ${process.cwd()} is not inside a git work tree`,
    );
  }
  return root;
}

export const GUARD_DEFAULTS = {
  gitCommit: true,
  gitPush: true,
  gitStash: true,
  gitDiscard: true,
  prCreate: true,
  custom: [],
};

/**
 * Defaults for the opt-in PreToolUse(Read) guard. Only unbounded whole-file reads, those
 * with no offset or limit, of generated or oversized files are redirected. `maxBytes` is
 * deliberately high so it catches only genuinely huge files, and `denyGlobs` handles the
 * common always-generated cases regardless of size.
 */
export const READ_GUARD_DEFAULTS = {
  enabled: true,
  maxBytes: 500000,
  denyGlobs: [
    '**/*.min.js',
    '**/*.min.css',
    '**/*.map',
    'pnpm-lock.yaml',
    'package-lock.json',
    'yarn.lock',
    'bun.lock',
    'bun.lockb',
    '**/dist/**',
    '**/build/**',
    '**/.next/**',
    '**/node_modules/**',
  ],
};

const EMPTY = Object.freeze({ targets: [] });
const cache = new Map();

/**
 * Reads `<repo>/.claude/houserules.config.json`, the declarative file adapting the scripts to a
 * repo's package layout and toolchain. CLI-style scripts demand a config and exit loudly
 * without one. Hooks must call `loadConfigSafe()` instead.
 */
export function loadConfig(
  root: string = repoRoot(),
  { required = true }: { required?: boolean } = {},
): HouseConfig {
  if (cache.has(root)) return cache.get(root);
  const path = resolve(root, '.claude/houserules.config.json');
  let config;
  if (!existsSync(path)) {
    if (required) {
      console.error(
        `houserules: missing ${path}\n` +
          'Run `npx houserules init` (or copy houserules.config.example.json) to create it.',
      );
      process.exit(1);
    }
    config = { targets: [] };
  } else {
    try {
      config = JSON.parse(readFileSync(path, 'utf8'));
    } catch (e) {
      if (required) {
        console.error(
          `houserules: ${path} is not valid JSON: ${(e as Error).message}`,
        );
        process.exit(1);
      }
      config = { targets: [] };
    }
  }
  config.targets ??= [];
  cache.set(root, config);
  return config;
}

/**
 * The loader hooks must use. It never exits and never throws, returning an empty config
 * in the worst case. A hook that crashes on a missing or broken config is noise on every
 * single tool call.
 *
 * @param root Pass the root when the caller already resolved one, which skips resolving
 * it again here.
 */
export function loadConfigSafe(root?: string): HouseConfig {
  try {
    return loadConfig(root ?? repoRoot(), { required: false });
  } catch {
    return EMPTY;
  }
}

/**
 * Repo-relative directory a plugin writes its tool fragments into, one
 * `<plugin>.json` file each. The core scripts read every fragment there, so a build tool's
 * specifics ship with the plugin for that tool and no core script names one.
 */
export const EXTENSIONS_DIR = '.claude/extensions';

/** What the installed tool fragments declare, merged across every fragment. */
export interface ToolExtensions {
  /**
   * Environment variables `verify-changed` sets to each job's outer fan-out, beside
   * `pnpm_config_workspace_concurrency`, such as a build orchestrator's parallelism cap.
   */
  shareVariables: string[];
  /**
   * Top-level `package.json` keys the changeset gate ignores. A manifest whose only
   * difference from the base is in these keys does not count as a package change.
   */
  manifestIgnoreKeys: string[];
}

const EXTENSION_LIST_KEYS = ['shareVariables', 'manifestIgnoreKeys'] as const;

function stringsIn(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is string => typeof item === 'string' && item !== '',
  );
}

/**
 * Merges every `*.json` fragment under {@link EXTENSIONS_DIR}, in filename order, with each
 * list deduplicated. Never throws: a missing directory, an unreadable file, a fragment that
 * is not JSON, or a key that is not a string array contributes nothing.
 */
export function loadExtensionsSafe(root: string): ToolExtensions {
  const merged: ToolExtensions = { shareVariables: [], manifestIgnoreKeys: [] };
  let names: string[];
  try {
    names = readdirSync(join(root, EXTENSIONS_DIR))
      .filter((name) => name.endsWith('.json'))
      .sort();
  } catch {
    return merged;
  }
  for (const name of names) {
    let fragment: Record<string, unknown>;
    try {
      fragment = JSON.parse(
        readFileSync(join(root, EXTENSIONS_DIR, name), 'utf8'),
      ) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (fragment === null || typeof fragment !== 'object') continue;
    for (const key of EXTENSION_LIST_KEYS) {
      for (const item of stringsIn(fragment[key])) {
        if (!merged[key].includes(item)) merged[key].push(item);
      }
    }
  }
  return merged;
}
