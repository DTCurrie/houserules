import { readFileSync } from 'node:fs';

/**
 * Tools whose use never writes to the working tree. A turn whose tool uses all fall in this
 * set is a read-only turn, and a Stop hook that exists to react to edits has nothing to do
 * after one. Any tool not named here, including every MCP tool and the agent-dispatching
 * tools, counts as a possible write, so an unknown tool fails safe to running the hook.
 */
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  'Read',
  'Grep',
  'Glob',
  'LS',
  'WebFetch',
  'WebSearch',
  'TodoWrite',
  'AskUserQuestion',
  'Skill',
  'ToolSearch',
  'ListAgents',
  'ListMcpResourcesTool',
  'ReadMcpResourceTool',
  'Monitor',
  'EnterPlanMode',
  'ExitPlanMode',
]);

interface ContentBlock {
  type?: string;
  name?: string;
}

/** The fields of a transcript record this module reads. Every other record type is skipped. */
export interface TurnRecord {
  type?: string;
  isMeta?: boolean;
  isCompactSummary?: boolean;
  origin?: { kind?: string };
  timestamp?: string;
  message?: { content?: unknown };
}

/**
 * Whether a `user` record carries a human prompt rather than a tool result. A meta record
 * (a command caveat), a task notification, and a compaction summary are inserted by the
 * harness and continue the turn already running. Stopping at one would hide the tool uses
 * before it, such as the dispatch of the background agent that just reported.
 */
function isHumanPrompt(record: TurnRecord): boolean {
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

function toolUseNames(record: TurnRecord): string[] {
  const content = record.message?.content;
  if (!Array.isArray(content)) return [];
  const names: string[] = [];
  for (const block of content as ContentBlock[])
    if (block?.type === 'tool_use' && typeof block.name === 'string')
      names.push(block.name);
  return names;
}

/**
 * Walks records newest first, collecting tool-use names until the last human prompt.
 * Null when no assistant record was seen before that prompt.
 */
function collectNewestFirst(records: Iterable<TurnRecord>): string[] | null {
  const names: string[] = [];
  let sawAssistant = false;
  for (const record of records) {
    if (isHumanPrompt(record)) break;
    if (record.type !== 'assistant') continue;
    sawAssistant = true;
    names.push(...toolUseNames(record).reverse());
  }
  return sawAssistant ? names.reverse() : null;
}

function* reversed<TItem>(items: readonly TItem[]): Iterable<TItem> {
  for (let i = items.length - 1; i >= 0; i--) yield items[i]!;
}

function readTranscriptLines(
  transcriptPath: string | undefined,
): string[] | undefined {
  if (!transcriptPath) return undefined;
  try {
    return readFileSync(transcriptPath, 'utf8').split('\n');
  } catch {
    return undefined;
  }
}

function* parsedFromEnd(lines: readonly string[]): Iterable<TurnRecord> {
  for (const line of reversed(lines)) {
    if (!line.trim()) continue;
    try {
      yield JSON.parse(line) as TurnRecord;
    } catch {
      // A truncated or malformed line is skipped, never fatal: a hook reads this on every stop.
    }
  }
}

/**
 * The name of every tool the assistant used since the last human prompt in `records`, in
 * transcript order. Null when no assistant record follows that prompt. Null is the lag case:
 * the harness writes the transcript asynchronously, so a file with no assistant record since
 * the prompt may not have caught up yet, and a caller must not read it as "no tools used".
 *
 * @param records Transcript records oldest first, as the `.jsonl` file holds them.
 */
export function toolUsesSinceLastPrompt(
  records: readonly TurnRecord[],
): string[] | null {
  return collectNewestFirst(reversed(records));
}

/**
 * Whether the turn that just ended may have written to the working tree, judged from the
 * tool uses recorded since the last human prompt in the transcript at `transcriptPath`.
 *
 * `false` means every tool use was in {@link READ_ONLY_TOOLS}, or there were none, so a Stop
 * hook that reacts to edits can exit before spawning anything. `true` means at least one
 * tool use could have written. `undefined` means the question has no answer: no path, an
 * unreadable file, or no assistant record since the prompt, which is how a lagging write
 * looks. A caller treats `undefined` exactly as it behaved before this gate existed.
 */
export function turnTouchedFiles(
  transcriptPath: string | undefined,
): boolean | undefined {
  const lines = readTranscriptLines(transcriptPath);
  if (!lines) return undefined;
  const uses = collectNewestFirst(parsedFromEnd(lines));
  if (uses === null) return undefined;
  return uses.some((name) => !READ_ONLY_TOOLS.has(name));
}

/**
 * When the turn that just ended began, as epoch milliseconds: the `timestamp` of the last
 * human prompt in the transcript at `transcriptPath`. Undefined when there is no path, the
 * file is unreadable, or no prompt carries a parseable timestamp. A lagging transcript can
 * only yield an earlier prompt, which widens the turn rather than narrowing it.
 */
export function turnStartedAt(
  transcriptPath: string | undefined,
): number | undefined {
  const lines = readTranscriptLines(transcriptPath);
  if (!lines) return undefined;
  for (const record of parsedFromEnd(lines)) {
    if (!isHumanPrompt(record)) continue;
    const startedAt = Date.parse(record.timestamp ?? '');
    return Number.isNaN(startedAt) ? undefined : startedAt;
  }
  return undefined;
}
