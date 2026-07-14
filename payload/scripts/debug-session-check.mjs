#!/usr/bin/env node
// SessionStart hook (claude-kit debug-session module). The deterministic backstop
// for the /debug-session cleanup guarantee ("remove ALL instrumentation, nothing
// orphaned"): prints a one-line reminder when an investigation is still open or when
// tagged instrumentation was left in source, so a paused or dropped debug session
// can't silently ship trace logging.
//
// stdout becomes session context — keep it tiny, and print NOTHING when there's
// nothing to report. Debugging is legitimately multi-session, so this only reminds;
// it never blocks. Every failure path exits 0 (a broken SessionStart hook would nag
// on every single session).

import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import { repoRoot } from './lib/kit-config.mjs';

// Shared with payload/skills/debug-session/SKILL.md — the tag on every trace edit
// and the throwaway-log directory. Keep both in sync with the skill.
const MARKER = 'CLAUDE-DEBUG';
const DEBUG_DIR = '.claude/debug';

// Active investigations = session logs the skill writes (.claude/debug/<slug>.jsonl).
function activeLogs(root) {
  try {
    return readdirSync(join(root, DEBUG_DIR)).filter((f) =>
      f.endsWith('.jsonl'),
    );
  } catch {
    return []; // dir absent/unreadable — nothing in flight.
  }
}

// Tagged instrumentation still in source. Excludes .claude/ so the skill, this
// script, and the logs themselves never count as orphans. --untracked catches a
// brand-new trace helper file too. Exit 1 (no matches) throws → caught → [].
function orphanedFiles(root) {
  try {
    const out = execFileSync(
      'git',
      ['grep', '--untracked', '-I', '-l', '-e', MARKER, '--', ':!.claude'],
      { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    return out.split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

try {
  const root = repoRoot();
  const logs = activeLogs(root);
  const orphans = orphanedFiles(root);
  const lines = [];
  if (logs.length) {
    lines.push(
      `[kit] open debug session(s): ${logs.join(', ')} under ${DEBUG_DIR}/ — /debug-session to resume or clean up.`,
    );
  }
  if (orphans.length) {
    const shown = orphans.slice(0, 5).join(', ');
    lines.push(
      `[kit] ${orphans.length} file(s) still carry ${MARKER} instrumentation (${shown}${orphans.length > 5 ? ', …' : ''}) — remove before committing (/debug-session step 9).`,
    );
  }
  if (lines.length) console.log(lines.join('\n'));
} catch {
  // Not a git tree, no git, or anything else — a reminder must never break a session.
}
process.exit(0);
