#!/usr/bin/env node
/**
 * PostToolUse(Edit|Write|MultiEdit) hook. Re-runs a target's user-owned generator when an
 * edited file matches its `sourceGlob`.
 *
 * A generator failure exits 2 with a trimmed tail so Claude sees it and fixes the source.
 * Every other path exits 0, because a PostToolUse hook that crashes would spew on every
 * edit.
 *
 * Config (kit.config.json): a target may carry a `regen` block of `sourceGlob` (for
 * example `packages/foo/data/**`) and `command` (for example `pnpm --filter foo gen`).
 * Keep the command fast and the sourceGlob tight. It runs on every matching edit.
 */

import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

import { loadConfigSafe } from './lib/kit-config.mjs';
import { globToRe, readStdinJson, repoRoot, tail } from './lib/proc.mjs';

interface RegenPayload {
  tool_input?: { file_path?: string; path?: string };
}

const input = readStdinJson<RegenPayload>();

const ti = input?.tool_input ?? {};
const filePath = ti.file_path ?? ti.path ?? '';
if (!filePath) process.exit(0);

try {
  const config = loadConfigSafe();
  const root = repoRoot();
  const abs = resolve(root, filePath);
  const rel = abs.startsWith(root) ? abs.slice(root.length + 1) : filePath;

  // Collect the distinct generator commands whose sourceGlob the edit matches.
  const commands: string[] = [];
  for (const t of config.targets ?? []) {
    const regen = t.regen;
    if (!regen?.sourceGlob || !regen?.command) continue;
    if (
      globToRe(regen.sourceGlob).test(rel) &&
      !commands.includes(regen.command)
    )
      commands.push(regen.command);
  }
  if (!commands.length) process.exit(0);

  const failures: { command: string; output: string }[] = [];
  for (const command of commands) {
    const r = spawnSync(command, {
      cwd: root,
      shell: true,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (r.status !== 0)
      failures.push({ command, output: (r.stdout || '') + (r.stderr || '') });
  }

  if (failures.length) {
    process.stderr.write(
      'agent-kit regen: a generator failed after your edit — fix the source, then it will re-run.\n',
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
