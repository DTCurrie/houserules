import type { LedgerRecord } from './push-queue.mjs';

/**
 * The `toolDenialKind` Claude Code writes on the `tool_result` record of a tool use the user
 * rejected at a permission prompt. A hook or a permission rule refusing the call writes a
 * different kind, `permission-rule`, and an auto-mode classifier writes `automode-blocked`.
 */
const USER_REJECTED_DENIAL_KIND = 'user-rejected';

/**
 * The opening sentence of the `tool_result` content for a tool use the user rejected, with or
 * without a follow-up message. Matched as a prefix, so a transcript written before
 * `toolDenialKind` existed still counts, while a tool result that only quotes the sentence does
 * not.
 */
export const USER_REJECTION_TEXT =
  "The user doesn't want to proceed with this tool use.";

/** A turn that holds a rejected tool use, as epoch milliseconds, `start` inclusive, `end` exclusive. */
export interface TurnWindow {
  start: number;
  end: number;
}

interface ContentBlock {
  type?: string;
  text?: string;
  content?: unknown;
}

/** The fields of a transcript record this module reads. */
interface TranscriptRecord {
  type?: string;
  sessionId?: string;
  isSidechain?: boolean;
  isMeta?: boolean;
  isCompactSummary?: boolean;
  origin?: { kind?: string };
  timestamp?: string;
  toolDenialKind?: string;
  message?: { content?: unknown };
}

/**
 * Whether a `user` record is a prompt the person typed. A meta record, a task notification, and
 * a compaction summary are inserted by the harness and continue the turn already running, and a
 * `tool_result` is the harness answering the assistant, never a new turn.
 */
function isHumanPrompt(record: TranscriptRecord): boolean {
  if (record.type !== 'user' || record.isMeta === true) return false;
  if (record.isCompactSummary === true) return false;
  if (record.origin?.kind === 'task-notification') return false;
  const content = record.message?.content;
  if (typeof content === 'string') return true;
  if (!Array.isArray(content)) return false;
  return !content.some(
    (block) => (block as ContentBlock)?.type === 'tool_result',
  );
}

/** The text a `tool_result` block carries, whether stored as a string or as text blocks. */
function toolResultText(block: ContentBlock): string {
  if (typeof block.content === 'string') return block.content;
  if (!Array.isArray(block.content)) return '';
  const first = (block.content as ContentBlock[])[0];
  return typeof first?.text === 'string' ? first.text : '';
}

function isUserRejection(record: TranscriptRecord): boolean {
  if (record.type !== 'user') return false;
  if (record.toolDenialKind === USER_REJECTED_DENIAL_KIND) return true;
  const content = record.message?.content;
  if (!Array.isArray(content)) return false;
  return (content as ContentBlock[]).some(
    (block) =>
      block?.type === 'tool_result' &&
      toolResultText(block).startsWith(USER_REJECTION_TEXT),
  );
}

function parseRecord(line: string): TranscriptRecord | null {
  if (!line.trim()) return null;
  try {
    const parsed: unknown = JSON.parse(line);
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as TranscriptRecord)
      : null;
  } catch {
    return null;
  }
}

/**
 * The time windows of every turn in `lines` that holds a tool use the user rejected.
 *
 * A turn runs from one human prompt's `timestamp` to the next one's, and the last turn runs on
 * with no end. A record stamped with another session id, a sidechain record, and a malformed line
 * are skipped, never fatal.
 *
 * @param lines The transcript `.jsonl`, one record per line, oldest first.
 * @param sessionId The session the transcript belongs to.
 */
export function rejectedTurnWindows(
  lines: readonly string[],
  sessionId: string,
): TurnWindow[] {
  const windows: TurnWindow[] = [];
  let turn: { start: number; rejected: boolean } | null = null;

  for (const line of lines) {
    const record = parseRecord(line);
    if (!record || record.isSidechain === true) continue;
    if (record.sessionId !== undefined && record.sessionId !== sessionId)
      continue;

    if (isHumanPrompt(record)) {
      const start = Date.parse(record.timestamp ?? '');
      if (Number.isNaN(start)) continue;
      if (turn?.rejected) windows.push({ start: turn.start, end: start });
      turn = { start, rejected: false };
      continue;
    }
    if (turn && isUserRejection(record)) turn.rejected = true;
  }

  if (turn?.rejected) windows.push({ start: turn.start, end: Infinity });
  return windows;
}

/**
 * The ledger rows `sessionId` wrote inside one of `windows`, which a push holds back.
 *
 * A row is tied to its change by the session that wrote it, `chat`, and the moment it was
 * written, `ts`. A row from another session, a row with no `chat`, and the executor's own
 * `synced` records are never held.
 */
export function rowsInRejectedTurns(
  records: readonly LedgerRecord[],
  windows: readonly TurnWindow[],
  sessionId: string,
): LedgerRecord[] {
  if (windows.length === 0) return [];
  return records.filter((record) => {
    if (record.action === 'synced' || record.chat !== sessionId) return false;
    const writtenAt = Date.parse(record.ts);
    if (Number.isNaN(writtenAt)) return false;
    return windows.some(
      (window) => writtenAt >= window.start && writtenAt < window.end,
    );
  });
}
