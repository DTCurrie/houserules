#!/usr/bin/env node
// PostToolUse(Bash) hook (claude-kit, EXPERIMENTAL). Compress-cache-retrieve for
// oversized command output: spill the full text to .claude/tool-output/ (which
// gitignores itself) and hand the model head + tail + a pointer instead.
//
// Emits { hookSpecificOutput: { hookEventName, updatedToolOutput } } on stdout.
// Where the running Claude Code version doesn't support updatedToolOutput, the
// JSON is ignored and behavior is stock — this hook can only ever no-op, never
// break. Exit 0 unconditionally.
//
// Config (kit.config.json): "compactor": { "threshold": 10000, "headLines": 20,
// "tailLines": 20 } — threshold is in characters, below it nothing happens.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { execSync } from 'node:child_process';

try {
  const input = JSON.parse(readFileSync(0, 'utf8') || '{}');
  if (input.tool_name !== 'Bash') process.exit(0);

  const resp = input.tool_response;
  const text =
    typeof resp === 'string'
      ? resp
      : [resp?.stdout, resp?.stderr].filter((s) => typeof s === 'string' && s.length).join('\n');

  let compactor = {};
  try {
    const root = execSync('git rev-parse --show-toplevel', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
    const config = JSON.parse(readFileSync(join(root, '.claude/kit.config.json'), 'utf8'));
    compactor = config.compactor ?? {};
    compactor.root = root;
  } catch {
    process.exit(0); // no repo/config — stay out of the way
  }

  const threshold = compactor.threshold ?? 10000;
  const headLines = compactor.headLines ?? 20;
  const tailLines = compactor.tailLines ?? 20;
  if (!text || text.length <= threshold) process.exit(0);

  const dir = join(compactor.root, '.claude', 'tool-output');
  mkdirSync(dir, { recursive: true });
  const selfIgnore = join(dir, '.gitignore');
  if (!existsSync(selfIgnore)) writeFileSync(selfIgnore, '*\n');

  const spillName = `bash-${Date.now()}-${randomBytes(2).toString('hex')}.txt`;
  writeFileSync(join(dir, spillName), text);
  const pointer = `.claude/tool-output/${spillName}`;

  const lines = text.split('\n');
  let updated;
  if (lines.length > headLines + tailLines + 1) {
    const omitted = lines.length - headLines - tailLines;
    updated = [
      ...lines.slice(0, headLines),
      `… [claude-kit compactor: ${omitted} lines omitted — full output saved to ${pointer}; grep it there if needed]`,
      ...lines.slice(-tailLines),
    ].join('\n');
  } else {
    // Few but enormous lines: fall back to a character split.
    updated = `${text.slice(0, 4000)}\n… [claude-kit compactor: ${text.length - 8000} chars omitted — full output: ${pointer}]\n${text.slice(-4000)}`;
  }

  console.log(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: updated },
    }),
  );
} catch {
  /* never break a tool call */
}
process.exit(0);
