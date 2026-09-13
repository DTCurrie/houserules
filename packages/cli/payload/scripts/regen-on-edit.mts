#!/usr/bin/env node
/**
 * PostToolUse(Edit|Write|MultiEdit) hook. Re-runs a target's user-owned generator when an
 * edited file matches its `sourceGlob`.
 *
 * A generator failure exits 2 with a trimmed tail so Claude sees it and fixes the source.
 * Every other path exits 0, because a PostToolUse hook that crashes would spew on every
 * edit.
 *
 * Config (houserules.config.json): a target may carry a `regen` block of `sourceGlob` (for
 * example `packages/foo/data/**`) and `command` (for example `pnpm --filter foo gen`).
 * Keep the command fast and the sourceGlob tight. It runs on every matching edit.
 */

import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { loadConfigSafe, type ConfigTarget } from '@houserules/payload/config';
import {
  globToRe,
  readStdinJson,
  repoRoot,
  tail,
} from '@houserules/payload/proc';

interface RegenPayload {
  tool_input?: { file_path?: string; path?: string };
}

/**
 * The distinct generator commands to run for an edit to `rel`, one per target whose
 * `regen.sourceGlob` matches, in target order, each command listed once.
 */
export function regenCommandsFor(
  rel: string,
  targets: ConfigTarget[],
): string[] {
  const commands: string[] = [];
  for (const t of targets) {
    const regen = t.regen;
    if (!regen?.sourceGlob || !regen?.command) continue;
    if (
      globToRe(regen.sourceGlob).test(rel) &&
      !commands.includes(regen.command)
    )
      commands.push(regen.command);
  }
  return commands;
}

function runCommand(
  command: string,
  cwd: string,
): { ok: boolean; output: string } {
  const r = spawnSync(command, {
    cwd,
    shell: true,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { ok: r.status === 0, output: (r.stdout || '') + (r.stderr || '') };
}

function main(): void {
  const input = readStdinJson<RegenPayload>();

  const ti = input?.tool_input ?? {};
  const filePath = ti.file_path ?? ti.path ?? '';
  if (!filePath) process.exit(0);

  try {
    const root = repoRoot();
    const config = loadConfigSafe(root);
    const abs = resolve(root, filePath);
    const rel = abs.startsWith(root) ? abs.slice(root.length + 1) : filePath;

    const commands = regenCommandsFor(rel, config.targets ?? []);
    if (!commands.length) process.exit(0);

    const failures: { command: string; output: string }[] = [];
    for (const command of commands) {
      const r = runCommand(command, root);
      if (!r.ok) failures.push({ command, output: r.output });
    }

    if (failures.length) {
      process.stderr.write(
        'houserules regen: a generator failed after your edit — fix the source, then it will re-run.\n',
      );
      for (const f of failures) {
        process.stderr.write(`\n--- ${f.command} ---\n`);
        process.stderr.write(`${tail(f.output, 40)}\n`);
      }
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
