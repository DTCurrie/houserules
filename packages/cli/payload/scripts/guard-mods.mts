#!/usr/bin/env node
/**
 * PreToolUse(Write|Edit|MultiEdit) guard. Refuses a file write into a Claude Code mod
 * directory unless the permission mode puts that write to the user.
 *
 * A mod runs inside Claude Code and can answer a tool call before any PreToolUse hook runs,
 * so a mod an agent writes could run past every houserules guard. In `auto` and
 * `bypassPermissions` modes Claude Code loads a mod Claude wrote without asking. In `default`
 * and `acceptEdits` it prompts for each write to a mod directory, so the guard lets those pass.
 *
 * Mod directories: `dev-mods/` under `CLAUDE_CONFIG_DIR` (else `~/.claude`), each entry of
 * `CLAUDE_CODE_PLUGIN_DIRS`, and any directory with a mod's own layout, a
 * `.claude-plugin/plugin.json` beside a `hooks/hooks.json` that declares `modules`. The target
 * path is resolved against the payload's `cwd`, with `..` and symlinks followed.
 *
 * Exit 2 with stderr refuses the write. Every other path, and any guard error, exits 0.
 */

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import {
  basename,
  delimiter,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path';
import { pathToFileURL } from 'node:url';

import { readStdinJson } from '@houserules/payload/proc';

interface WritePayload {
  cwd?: string;
  permission_mode?: string;
  tool_input?: { file_path?: string };
}

/** Where the guard looks for mods, taken from the environment Claude Code runs it in. */
export interface ModLocations {
  configDir: string;
  pluginDirs: string[];
}

// Claude Code prompts for a write to a mod directory in these modes, so the user decides.
const PROMPTED_MODES = new Set(['default', 'acceptEdits']);

/** The mod locations `env` names, defaulting the config directory to `~/.claude`. */
export function modLocationsFrom(env: NodeJS.ProcessEnv): ModLocations {
  const configDir = env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
  const pluginDirs = (env.CLAUDE_CODE_PLUGIN_DIRS ?? '')
    .split(delimiter)
    .filter((dir) => dir !== '');
  return { configDir, pluginDirs };
}

/**
 * `path` with every symlink in it followed. A tail that does not exist yet, such as the file a
 * Write is about to create, is appended to the real path of its deepest existing ancestor.
 */
function realPathOf(path: string): string {
  const missingTail: string[] = [];
  let current = path;
  for (;;) {
    try {
      return join(realpathSync(current), ...missingTail);
    } catch {
      const parent = dirname(current);
      if (parent === current) return path;
      missingTail.unshift(basename(current));
      current = parent;
    }
  }
}

function isInside(dir: string, target: string): boolean {
  const relativePath = relative(dir, target);
  return (
    relativePath === '' ||
    (!relativePath.startsWith('..') && !isAbsolute(relativePath))
  );
}

function declaresModules(hooksJson: string): boolean {
  try {
    const parsed = JSON.parse(readFileSync(hooksJson, 'utf8')) as {
      modules?: unknown;
    };
    return Array.isArray(parsed.modules);
  } catch {
    return false;
  }
}

/** The nearest ancestor of `target` laid out as a mod, or null when none is. */
function enclosingModDir(target: string): string | null {
  let dir = dirname(target);
  for (;;) {
    if (
      existsSync(join(dir, '.claude-plugin', 'plugin.json')) &&
      declaresModules(join(dir, 'hooks', 'hooks.json'))
    ) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** The mod directory `target` resolves into, or null when it resolves into none. */
function modDirHolding(target: string, locations: ModLocations): string | null {
  const roots = [
    join(locations.configDir, 'dev-mods'),
    ...locations.pluginDirs,
  ];
  const match = roots.find((root) => isInside(realPathOf(root), target));
  return match ?? enclosingModDir(target);
}

/**
 * The stderr message refusing a write of `filePath`, or null when the path is outside every
 * mod directory or `permissionMode` prompts the user for the write.
 */
export function modGuardRefusalFor(
  filePath: string,
  permissionMode: string | undefined,
  cwd: string,
  locations: ModLocations,
): string | null {
  if (!filePath) return null;
  if (permissionMode && PROMPTED_MODES.has(permissionMode)) return null;

  const target = realPathOf(resolve(cwd, filePath));
  const modDir = modDirHolding(target, locations);
  if (!modDir) return null;

  return (
    `houserules mod guard: ${target} is inside the Claude Code mod directory ${modDir}. ` +
    `A mod loads without asking in ${permissionMode ?? 'this'} mode and runs ahead of every ` +
    `PreToolUse hook, so this write was not made. Tell the user what the mod should do and ` +
    `let them write it, or ask them to switch to default or acceptEdits mode, where each ` +
    `mod file write is put to them.\n`
  );
}

function main(): void {
  const input = readStdinJson<WritePayload>();
  const filePath = input?.tool_input?.file_path ?? '';
  if (!filePath) process.exit(0);

  try {
    const refusal = modGuardRefusalFor(
      filePath,
      input.permission_mode,
      input.cwd ?? process.cwd(),
      modLocationsFrom(process.env),
    );
    if (refusal) {
      process.stderr.write(refusal);
      process.exit(2);
    }
  } catch {
    process.exit(0);
  }

  process.exit(0);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
  main();
}
