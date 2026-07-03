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

export function repoRoot() {
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

const EMPTY = Object.freeze({ targets: [] });
const cache = new Map();

export function loadConfig(root = repoRoot(), { required = true } = {}) {
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
        console.error(`claude-kit: ${path} is not valid JSON: ${e.message}`);
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
export function loadConfigSafe() {
  try {
    return loadConfig(repoRoot(), { required: false });
  } catch {
    return EMPTY;
  }
}

export function targetByName(config, name) {
  return config.targets.find((t) => t.name === name);
}
