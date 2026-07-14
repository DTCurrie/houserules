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

// Match a guarded command only in COMMAND position — at the start of the line or right
// after a shell separator (newline ; && || | &) — so the guard never fires on the same
// words inside another command's argument (`grep "git commit"`, `echo "git commit"`,
// `node -e '… git commit …'`). Accepted limitations (best-effort, not a shell parser):
// a separator INSIDE quotes (`echo "a && git commit"`) can still mis-anchor, and
// wrapped/nested forms (`sh -c "git commit"`, `xargs git commit`, `x=$(git commit)`)
// are NOT caught.
const CMD_START = String.raw`(?:^|[\n;&|])\s*`;
// Tolerate flag/option arguments before a git subcommand: `git -C /path commit`,
// `git -c k=v stash`, `git --no-pager push`.
const GIT_FLAGS = String.raw`(?:-[A-Za-z]\s+\S+\s+|--?\S+\s+)*`;
const gitRule = (sub, msg) => ({
  re: new RegExp(`${CMD_START}git\\s+${GIT_FLAGS}${sub}\\b`),
  msg,
});

const DENY = [];
if (guard.gitCommit) {
  DENY.push(
    gitRule(
      'commit',
      "git commit is the user's to run. Describe what's staged and stop.",
    ),
  );
}
if (guard.gitPush) {
  DENY.push(gitRule('push', "git push is the user's to run."));
}
if (guard.gitStash) {
  DENY.push(
    gitRule(
      'stash',
      'git stash dumps the full untracked-file list into context. Use `git diff --name-only`, `git show HEAD:<path>`, or inspect the one file you changed.',
    ),
  );
}
if (guard.prCreate) {
  DENY.push({
    re: new RegExp(`${CMD_START}gh\\s+${GIT_FLAGS}(?:pr|issue)\\s+create\\b`),
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
