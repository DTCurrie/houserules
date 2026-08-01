// Shared helpers for the claude-kit scripts: git-root discovery and the per-repo
// config loader. kit.config.json lives at <repo>/.claude/kit.config.json and is the
// single declarative file that adapts the scripts to a repo's package layout and
// toolchain (schema version 2 — see kit.config.example.json in the kit repo).
//
// Loading discipline: CLI-style scripts (package-changelog) demand a config and
// exit loudly without one; HOOK scripts must use loadConfigSafe() — a hook that
// crashes on a missing/broken config turns into noise on every single tool call.

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execSync } from 'node:child_process';

// The shape the HOOKS read, typed loosely on purpose.
//
// `src/core/config.ts` holds the strict zod schema and is the authority on what a
// VALID kit.config.json looks like. This reader is the other half of that split: it
// runs inside a user's repo with no dependencies and must cope with a config the
// schema would reject outright — a hook that dies on a bad config is noise on every
// tool call. So every field here is optional, and callers default rather than assume.
// The two cannot be one type: the payload is compiled with rootDir=payload and can
// never import from src/ (that would drag zod into a user's repo).

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
  readGuard?: { enabled?: boolean; maxBytes?: number; denyGlobs?: string[] };
  claudeMd?: { managed?: boolean };
  targets: ConfigTarget[];
  [key: string]: unknown;
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

// Defaults for the opt-in PreToolUse(Read) guard (config.readGuard). Only unbounded
// whole-file reads (no offset/limit) of generated/oversized files are redirected;
// maxBytes is deliberately high so it catches only genuinely huge files, with
// denyGlobs handling the common always-generated cases regardless of size.
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
        `claude-kit: missing ${path}\n` +
          'Run `npx claude-kit init` (or copy kit.config.example.json) to create it.',
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
          `claude-kit: ${path} is not valid JSON: ${(e as Error).message}`,
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

// For hooks: never exits, never throws — worst case an empty config.
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
