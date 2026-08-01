#!/usr/bin/env node
// Opt-in PostToolUse(Edit|Write|MultiEdit) hook (claude-kit). When an edited file
// matches a target's `regen { sourceGlob, command }`, re-run that USER-OWNED
// generator so a fragmented-corpus reference snapshot stays fresh and grep-able
// instead of silently staling (CONVENTIONS §7). On generator failure, exit 2 with a
// trimmed tail so Claude sees it and fixes the source. Every OTHER path exits 0 — a
// PostToolUse hook that crashes would spew on every edit.
//
// Config (kit.config.json): a target may carry
//   "regen": { "sourceGlob": "packages/foo/data/**/*.json", "command": "pnpm --filter foo gen" }
// Keep the command fast and the sourceGlob tight — it runs on every matching edit.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

import { loadConfigSafe } from './lib/kit-config.mjs';

interface RegenPayload {
  tool_input?: { file_path?: string; path?: string };
}

let input: RegenPayload = {};
try {
  input = JSON.parse(readFileSync(0, 'utf8') || '{}');
} catch {
  process.exit(0);
}

const ti = input?.tool_input ?? {};
const filePath = ti.file_path ?? ti.path ?? '';
if (!filePath) process.exit(0);

// `**` spans separators, `*` does not.
function globToRe(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
        if (glob[i + 1] === '/') i++;
      } else re += '[^/]*';
    } else if ('.+^${}()|[]\\'.includes(c)) re += `\\${c}`;
    else if (c === '?') re += '[^/]';
    else re += c;
  }
  return new RegExp(`^${re}$`);
}

function tail(text: string, n: number): string {
  const parts = String(text ?? '').split('\n');
  return parts.slice(Math.max(0, parts.length - n)).join('\n');
}

try {
  const config = loadConfigSafe();
  let root: string;
  try {
    root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    root = process.cwd();
  }
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
      'claude-kit regen: a generator failed after your edit — fix the source, then it will re-run.\n',
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
