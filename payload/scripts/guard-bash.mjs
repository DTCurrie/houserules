#!/usr/bin/env node
// PreToolUse(Bash) guard (claude-kit). Converts load-bearing prose rules into a
// deterministic check, so the model can't burn a turn violating them:
//   1. "The user always handles git commit / push / PR-create."  (a violated commit
//       costs a full wasted turn plus cleanup.)
//   2. Context hygiene: `git stash` dumps the whole untracked-file list into context.
//
// Exit 2 + stderr blocks the tool call and feeds the reason back to Claude. Exit 0
// allows. Wire it as a PreToolUse hook with matcher "Bash" (init does this).
//
// Rules are configured in .claude/kit.config.json (all default ON):
//   "guard": { "gitCommit": true, "gitPush": true, "gitStash": true, "prCreate": true,
//              "custom": [{ "pattern": "\\bdocker\\s+system\\s+prune\\b", "message": "..." }] }
// Config missing or unreadable → the four defaults apply. Keep custom rules
// conservative — only commands that are genuinely the user's to run.

import { readFileSync } from 'node:fs';

import { GUARD_DEFAULTS, loadConfigSafe } from './lib/kit-config.mjs';

let input = {};
try {
  input = JSON.parse(readFileSync(0, 'utf8') || '{}');
} catch {
  process.exit(0); // No parseable payload — don't block.
}

const cmd = input?.tool_input?.command ?? '';
if (!cmd) process.exit(0);

const guard = { ...GUARD_DEFAULTS, ...(loadConfigSafe().guard ?? {}) };

const DENY = [];
if (guard.gitCommit) {
  DENY.push({
    re: /\bgit\s+commit\b/,
    msg: "git commit is the user's to run. Describe what's staged and stop.",
  });
}
if (guard.gitPush) {
  // Tolerates flag arguments before the subcommand: `git -C /path push`, `git -c k=v push`.
  DENY.push({
    re: /\bgit\s+(?:-[A-Za-z]\s+\S+\s+|--?\S+\s+)*push\b/,
    msg: "git push is the user's to run.",
  });
}
if (guard.gitStash) {
  DENY.push({
    re: /\bgit\s+stash\b/,
    msg: 'git stash dumps the full untracked-file list into context. Use `git diff --name-only`, `git show HEAD:<path>`, or inspect the one file you changed.',
  });
}
if (guard.prCreate) {
  DENY.push({
    re: /\bgh\s+(?:pr|issue)\s+create\b/,
    msg: "Opening PRs/issues is the user's call. Describe what's ready and stop.",
  });
}
for (const rule of guard.custom ?? []) {
  try {
    DENY.push({
      re: new RegExp(rule.pattern),
      msg:
        rule.message ??
        `Blocked by kit.config.json guard rule: ${rule.pattern}`,
    });
  } catch {
    // Invalid user regex: skip the rule rather than break every Bash call.
  }
}

for (const d of DENY) {
  if (d.re.test(cmd)) {
    process.stderr.write(`Blocked by claude-kit guard: ${d.msg}\n`);
    process.exit(2);
  }
}

process.exit(0);
