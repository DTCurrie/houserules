import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execSync } from 'node:child_process';

export interface RunnerBlock {
  runner?: string;
  filterFlag?: string;
  runScriptPrefix?: string[];
  commands?: string[];
  /** `fix` only: run the fixer when a subagent stops. */
  onSubagentStop?: boolean;
  /** `fix` only: per-command file extensions, e.g. {"lint:fix": ["ts","tsx"]}. */
  commandExtensions?: Record<string, string[]>;
  /** `verify` only: branch the changed-file diff is taken against. */
  baseBranch?: string;
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
 * strict zod schema and is the authority on what a valid kit.config.json looks like. This
 * reader is the other half of that split. It runs inside a user's repo with no
 * dependencies and has to cope with a config the schema would reject outright, because a
 * hook that dies on a bad config is noise on every tool call. Every field is therefore
 * optional and callers default rather than assume.
 *
 * The two cannot be one type. The payload compiles with `rootDir=payload` and can never
 * import from `src/`, which would drag zod into a user's repo.
 */
export interface KitConfig {
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
    prCreate?: boolean;
    custom?: { pattern: string; message: string }[];
  };
  changesets?: { enabled?: boolean; stopCheck?: boolean; baseBranch?: string };
  ledger?: { enabled?: boolean };
  ledgers?: { dir?: string };
  readGuard?: { enabled?: boolean; maxBytes?: number; denyGlobs?: string[] };
  claudeMd?: { managed?: boolean };
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

export function repoRoot(): string {
  return execSync('git rev-parse --show-toplevel', {
    stdio: ['ignore', 'pipe', 'ignore'],
  })
    .toString()
    .trim();
}

export const GUARD_DEFAULTS = {
  gitCommit: true,
  gitPush: true,
  gitStash: true,
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
 * Reads `<repo>/.claude/kit.config.json`, the declarative file adapting the scripts to a
 * repo's package layout and toolchain. CLI-style scripts demand a config and exit loudly
 * without one. Hooks must call `loadConfigSafe()` instead.
 */
export function loadConfig(
  root: string = repoRoot(),
  { required = true }: { required?: boolean } = {},
): KitConfig {
  if (cache.has(root)) return cache.get(root);
  const path = resolve(root, '.claude/kit.config.json');
  let config;
  if (!existsSync(path)) {
    if (required) {
      console.error(
        `agent-kit: missing ${path}\n` +
          'Run `npx agent-kit init` (or copy kit.config.example.json) to create it.',
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
          `agent-kit: ${path} is not valid JSON: ${(e as Error).message}`,
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
 */
export function loadConfigSafe(): KitConfig {
  try {
    return loadConfig(repoRoot(), { required: false });
  } catch {
    return EMPTY;
  }
}

export function targetByName(
  config: KitConfig,
  name: string,
): ConfigTarget | undefined {
  return config.targets.find((t) => t.name === name);
}
