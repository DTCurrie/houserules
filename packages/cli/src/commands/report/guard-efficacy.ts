import type { Corpus } from './transcript-events.js';
import { isCrash, uncoveredOutcomes } from './hook-crash.js';
import { renderTable } from './render-table.js';

const COMMAND_LIST_PREVIEW_LENGTH = 80;
const UNKNOWN_GUARD = '(unknown guard)';
const UNKNOWN_REASON = '(no reason recorded)';
const GUARD_NOTICE_PREFIX = 'Blocked by houserules guard: ';

export interface GuardBlock {
  session: string;
  blockedCommand: string;
  /** The hook that refused the call, such as `PreToolUse:Bash`. */
  guard?: string;
  /** The first line of the hook's refusal, without the guard notice prefix. */
  reason?: string;
}

function reasonOf(stderr: string): string {
  const firstLine = stderr.split('\n').find((line) => line.trim());
  if (!firstLine) return UNKNOWN_REASON;
  const trimmed = firstLine.trim();
  return trimmed.startsWith(GUARD_NOTICE_PREFIX)
    ? trimmed.slice(GUARD_NOTICE_PREFIX.length)
    : trimmed;
}

function previewCommand(command: string): string {
  const flat = command.replace(/\s*\n\s*/g, ' ');
  if (flat.length <= COMMAND_LIST_PREVIEW_LENGTH) return flat;
  return `${flat.slice(0, COMMAND_LIST_PREVIEW_LENGTH - 1)}…`;
}

export function computeGuardBlocks(corpus: Corpus): GuardBlock[] {
  const blocks: GuardBlock[] = [];
  for (const [sessionId, session] of corpus.sessions) {
    for (const fire of session.hookFires) {
      if (!fire.hookName.startsWith('PreToolUse')) continue;
      if (!fire.exitCode || isCrash(fire)) continue;
      const knownIndex =
        fire.toolUseID !== undefined
          ? session.toolUseIndexById.get(fire.toolUseID)
          : undefined;
      const blocked =
        knownIndex !== undefined ? session.toolUses[knownIndex] : undefined;
      blocks.push({
        session: sessionId.slice(0, 8),
        blockedCommand: blocked?.command ?? '(tool_use not found)',
        guard: fire.hookName,
        reason: reasonOf(fire.stderr || fire.content),
      });
    }
    for (const outcome of uncoveredOutcomes(session)) {
      if (isCrash(outcome)) continue;
      const index =
        outcome.toolUseId !== undefined
          ? session.toolUseIndexById.get(outcome.toolUseId)
          : undefined;
      const use = index !== undefined ? session.toolUses[index] : undefined;
      blocks.push({
        session: sessionId.slice(0, 8),
        blockedCommand: use?.command || use?.name || '(tool_use not found)',
        guard: `PreToolUse:${outcome.tool}`,
        reason: reasonOf(outcome.stderr),
      });
    }
  }
  return blocks;
}

interface GuardSummaryRow {
  guard: string;
  reason: string;
  count: number;
}

/** Block counts per guard and reason, largest first, ties broken by guard then reason. */
function summarizeGuardBlocks(blocks: GuardBlock[]): GuardSummaryRow[] {
  const counts = new Map<string, GuardSummaryRow>();
  for (const block of blocks) {
    const guard = block.guard ?? UNKNOWN_GUARD;
    const reason = block.reason ?? UNKNOWN_REASON;
    const key = JSON.stringify([guard, reason]);
    const entry = counts.get(key) ?? { guard, reason, count: 0 };
    entry.count += 1;
    counts.set(key, entry);
  }
  return [...counts.values()].sort(
    (a, b) =>
      b.count - a.count ||
      a.guard.localeCompare(b.guard) ||
      a.reason.localeCompare(b.reason),
  );
}

export function renderGuardEfficacy(blocks: GuardBlock[]): string[] {
  const lines = ['-- guard efficacy --', ''];
  if (blocks.length === 0) {
    lines.push(
      '  no genuine blocks in this corpus (every non-zero PreToolUse exit was a hook crash)',
    );
    return lines;
  }
  lines.push(
    ...renderTable(
      ['guard', 'reason', 'blocks'],
      summarizeGuardBlocks(blocks).map((row) => [
        row.guard,
        row.reason,
        row.count,
      ]),
    ),
    '',
  );
  for (const block of blocks)
    lines.push(
      `  ${block.session}  blocked: ${previewCommand(block.blockedCommand)}`,
    );
  return lines;
}
