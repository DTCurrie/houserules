#!/usr/bin/env node
/**
 * PreToolUse(Bash) guard. Blocks the git commands the user always runs themselves, plus
 * `git stash`, which dumps the whole untracked-file list into context.
 *
 * Exit 2 with stderr blocks the tool call and feeds the reason back to Claude. Exit 0
 * allows. Wire it as a PreToolUse hook with matcher "Bash".
 *
 * Config (.claude/kit.config.json, all default on):
 *   "guard": { "gitCommit": true, "gitPush": true, "gitStash": true, "prCreate": true,
 *              "custom": [{ "pattern": "\\bdocker\\s+system\\s+prune\\b", "message": "..." }] }
 * A missing or unreadable config falls back to the four defaults.
 */

import { GUARD_DEFAULTS, loadConfigSafe } from './lib/kit-config.mjs';
import { readStdinJson } from './lib/proc.mjs';

interface BashPayload {
  tool_input?: { command?: string };
}

const input = readStdinJson<BashPayload>();

const cmd = input?.tool_input?.command ?? '';
if (!cmd) process.exit(0);

const guard = { ...GUARD_DEFAULTS, ...(loadConfigSafe().guard ?? {}) };

// Matches only in COMMAND position, so the guard never fires on the same words inside
// another command's argument. Not a shell parser: nested forms are not caught.
const CMD_START = String.raw`(?:^|[\n;&|])\s*`;
// Tolerate flag/option arguments before a git subcommand: `git -C /path commit`,
// `git -c k=v stash`, `git --no-pager push`.
const GIT_FLAGS = String.raw`(?:-[A-Za-z]\s+\S+\s+|--?\S+\s+)*`;
const gitRule = (sub: string, msg: string) => ({
  re: new RegExp(`${CMD_START}git\\s+${GIT_FLAGS}${sub}\\b`),
  msg,
});

const DENY: { re: RegExp; msg: string }[] = [];
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
