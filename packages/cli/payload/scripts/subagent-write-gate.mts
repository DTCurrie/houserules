#!/usr/bin/env node
/**
 * PreToolUse(Bash) gate refusing ledger and changeset writes from any subagent turn.
 *
 * Identity: `tool_input` carries only the Bash command, so whether the caller is a
 * subagent comes from `transcript_path`. A subagent's own transcript never carries the
 * `subagent_type` its parent session used to launch it (only the parent's transcript has
 * that), so this gate cannot scope to one particular agent. It gates every subagent
 * instead, on the trailing turn's `isSidechain` flag, which both transcripts do carry.
 *
 * Scope: subagents authoring changesets one-per-incremental-change instead of one-per-
 * feature has produced changeset pollution, so both the backlog/decision ledgers and
 * `.changeset/` are refused from any sidechain. Reads stay allowed everywhere.
 *
 * When identity can't be established (no transcript, unreadable, not a sidechain), the
 * gate allows, because a false refusal blocks legitimate work far worse than a missed
 * write.
 *
 * Exit 2 with stderr blocks the tool call. Exit 0 allows. Wire as a PreToolUse hook with
 * matcher "Bash".
 *
 * `--diagnose <transcript-path>` is a separate, manually-run mode (never invoked by the
 * hook itself) that reports whether the trailing turn resolves to a sidechain at all,
 * printing JSON and exiting 0 when it does, 1 when it does not. A gate that always fails
 * open because it can no longer find an assistant turn looks identical, from the hook's
 * silence, to a gate that correctly saw nothing to refuse. This is how you tell the two
 * apart.
 */

import { readFileSync } from 'node:fs';

import { readStdinJson } from '@houserules/payload/proc';

interface BashPayload {
  tool_input?: { command?: string };
  transcript_path?: string;
}

interface TranscriptRecord {
  type?: string;
  isSidechain?: boolean;
}

function readTranscriptLines(path: string): TranscriptRecord[] {
  const text = readFileSync(path, 'utf8');
  const lines: TranscriptRecord[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      lines.push(JSON.parse(line) as TranscriptRecord);
    } catch {
      // Malformed line: skip it rather than aborting the whole scan.
    }
  }
  return lines;
}

/**
 * Whether the trailing assistant turn in the transcript is a subagent sidechain. Fails
 * open (false) on any transcript that can't be read or has no assistant turn at all.
 */
function isSidechainTurn(transcriptPath: string | undefined): boolean {
  if (!transcriptPath) return false;

  let records: TranscriptRecord[];
  try {
    records = readTranscriptLines(transcriptPath);
  } catch {
    return false;
  }

  const lastTurn = [...records].reverse().find((r) => r.type === 'assistant');
  return lastTurn?.isSidechain === true;
}

// Command-position match only, like guard-bash: never fires on the same words inside
// another command's argument. Not a shell parser, so nested/obfuscated forms slip through.
const CMD_START = String.raw`(?:^|[\n;&|])\s*`;

const BACKLOG_MUTATING = ['add', 'remove', 'update', 'move', 'render'];
const BACKLOG_MUTATING_RE = new RegExp(
  `${CMD_START}node\\s+\\S*backlog-log\\.mjs\\s+(${BACKLOG_MUTATING.join('|')})\\b`,
);

const DECISION_MUTATING = [
  'decide',
  'supersede',
  'amend',
  'move',
  'rescope',
  'render',
];
const DECISION_MUTATING_RE = new RegExp(
  `${CMD_START}node\\s+\\S*decision-log\\.mjs\\s+(${DECISION_MUTATING.join('|')})\\b`,
);

// changeset-write.mjs has no read-only subcommand: any invocation writes a changeset.
const CHANGESET_WRITE_RE = new RegExp(
  `${CMD_START}node\\s+\\S*changeset-write\\.mjs\\b`,
);

// Direct edits to a ledger or changeset surface, bypassing the CLI scripts entirely.
// `sed -i`/`tee` are checked in command position, like the subcommand matches above, so a
// read command whose ARGUMENT happens to contain the word "tee" (e.g. a grep pattern)
// never trips it. Redirection (`>`/`>>`) is checked separately, unanchored, since it is a
// shell operator that appears after the command rather than in command position.
const LEDGER_TARGET = String.raw`(?:BACKLOG\.md|DECISIONS\.md|ledgers/backlog\.jsonl|ledgers/decisions\.jsonl|\.changeset/[\w.-]+\.(?:md|json))`;
const DIRECT_EDIT_RE = new RegExp(
  `${CMD_START}(?:sed\\s+-i\\b|tee\\b).*?${LEDGER_TARGET}`,
);
const REDIRECT_RE = new RegExp(
  `(?:^|[\\s;&|])>>?\\s*(?:\\S*/)?${LEDGER_TARGET}\\b`,
);

function runDiagnose(transcriptPath: string): never {
  const sidechainDetected = isSidechainTurn(transcriptPath);
  process.stdout.write(
    `${JSON.stringify({ transcriptPath, sidechainDetected }, null, 2)}\n`,
  );
  process.exit(sidechainDetected ? 0 : 1);
}

function main(): void {
  if (process.argv[2] === '--diagnose') {
    const transcriptPath = process.argv[3];
    if (!transcriptPath) {
      process.stderr.write('--diagnose requires a transcript path\n');
      process.exit(1);
    }
    runDiagnose(transcriptPath);
    return;
  }

  const input = readStdinJson<BashPayload>();
  const cmd = input?.tool_input?.command ?? '';
  if (!cmd) process.exit(0);

  if (!isSidechainTurn(input?.transcript_path)) process.exit(0);

  const mutatingMatch =
    cmd.match(BACKLOG_MUTATING_RE) ?? cmd.match(DECISION_MUTATING_RE);
  if (mutatingMatch) {
    process.stderr.write(
      `Blocked by houserules subagent write gate: a subagent may not run ledger command ` +
        `\`${mutatingMatch[1]}\`. Describe the issue and let the caller act on it.\n`,
    );
    process.exit(2);
  }

  if (CHANGESET_WRITE_RE.test(cmd)) {
    process.stderr.write(
      'Blocked by houserules subagent write gate: a subagent may not author a changeset. ' +
        'Changesets are one per feature, not one per incremental change. Describe the ' +
        'change and let the caller record it.\n',
    );
    process.exit(2);
  }

  if (DIRECT_EDIT_RE.test(cmd) || REDIRECT_RE.test(cmd)) {
    process.stderr.write(
      'Blocked by houserules subagent write gate: a subagent may not edit a ledger or ' +
        'changeset file directly.\n',
    );
    process.exit(2);
  }

  process.exit(0);
}

main();
