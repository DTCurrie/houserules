/**
 * Reducing a ledger to the records that can still change something.
 *
 * The ledgers are append-only, so their size tracks how much work has happened rather than how
 * much is outstanding. Once GitHub Projects became the durable record that stopped being a fair
 * trade: an entry that reached the board and has not been touched since is fully described by one
 * line, and an entry that was removed before it ever reached the board is fully described by no
 * lines at all. This module decides which of the three each entry is.
 *
 * Entirely pure, like {@link push-queue}. It never reads or writes a file, and the executor in
 * `projects-sync.mts` is what applies the result.
 *
 * Two invariants make the rewrite safe, and the executor checks both against real data before it
 * replaces anything:
 *
 * 1. The push queue built from the compacted records equals the one built from the originals.
 *    Compaction must never turn finished work back into pending work, or hide pending work.
 * 2. Every surviving entry keeps every field its birth record carried. The two ledger scripts
 *    project fields this module has no type for, such as a decision's `under`, and a checkpoint
 *    built only from what the push fold knows would drop them.
 */

import {
  foldBacklog,
  foldDecisions,
  isBacklogTerminal,
  type BacklogState,
  type DecisionState,
  type LedgerCheckpoint,
  type LedgerRecord,
  type PushOp,
} from './push-queue.mjs';

/** What one ledger's compaction produced, and which entries went which way. */
export interface CompactionResult {
  records: LedgerRecord[];
  /** Ids removed outright, because nothing can ever be pushed for them again. */
  dropped: string[];
  /** Ids collapsed to a single checkpoint record. */
  folded: string[];
  /** Ids left byte-for-byte alone, because a push still owes them something. */
  kept: string[];
}

/**
 * The entries some operation in `queue` still names.
 *
 * Taken from the queue rather than from each entry's own state, because a `mark-superseded` op is
 * emitted under the successor's id and names the target. Reading the target's state alone would
 * call it finished while a flip for it was still queued.
 */
export function pendingEntryIds(queue: readonly PushOp[]): Set<string> {
  return new Set(queue.map((op) => op.entryId));
}

/** The birth record of every entry, which is the one a checkpoint rewrites. */
function birthRecords(
  records: readonly LedgerRecord[],
  actions: readonly string[],
): Map<string, LedgerRecord> {
  const births = new Map<string, LedgerRecord>();
  for (const record of records) {
    if (actions.includes(record.action)) births.set(record.id, record);
  }
  return births;
}

/**
 * One record standing in for an entry's whole history.
 *
 * Spreads the birth record first so every field it carried survives, including the ones neither
 * this module nor the push fold has a type for. Only the fields the fold can actually change are
 * overlaid on top.
 */
function checkpointRecord(
  birth: LedgerRecord,
  folded: Partial<LedgerRecord>,
  checkpoint: LedgerCheckpoint,
): LedgerRecord {
  return { ...birth, ...folded, checkpoint };
}

function backlogCheckpoint(
  birth: LedgerRecord,
  state: BacklogState,
): LedgerRecord {
  return checkpointRecord(
    birth,
    { file: state.file, title: state.title, content: state.content },
    { ...(state.syncedIssue !== undefined && { issue: state.syncedIssue }) },
  );
}

function decisionCheckpoint(
  birth: LedgerRecord,
  state: DecisionState,
): LedgerRecord {
  return checkpointRecord(
    birth,
    { file: state.file, content: state.content, scope: state.scope },
    {
      ...(state.syncedItemId !== undefined && { itemId: state.syncedItemId }),
      ...(state.markedSuperseded && { markedSuperseded: true }),
    },
  );
}

/** Every record belonging to `id`, in their original order. */
function recordsFor(
  records: readonly LedgerRecord[],
  id: string,
): LedgerRecord[] {
  return records.filter((record) => record.id === id);
}

export function compactBacklog(
  records: readonly LedgerRecord[],
  pending: ReadonlySet<string>,
): CompactionResult {
  const { entries, order } = foldBacklog(records);
  const births = birthRecords(records, ['add']);
  const result: CompactionResult = {
    records: [],
    dropped: [],
    folded: [],
    kept: [],
  };

  for (const id of order) {
    const state = entries.get(id);
    const birth = births.get(id);
    if (!state || !birth) continue;

    if (pending.has(id)) {
      result.kept.push(id);
      result.records.push(...recordsFor(records, id));
    } else if (isBacklogTerminal(state)) {
      result.dropped.push(id);
    } else {
      result.folded.push(id);
      result.records.push(backlogCheckpoint(birth, state));
    }
  }

  return result;
}

export function compactDecisions(
  records: readonly LedgerRecord[],
  pending: ReadonlySet<string>,
): CompactionResult {
  const { entries, order } = foldDecisions(records);
  const births = birthRecords(records, ['decide', 'supersede']);
  const result: CompactionResult = {
    records: [],
    dropped: [],
    folded: [],
    kept: [],
  };

  for (const id of order) {
    const state = entries.get(id);
    const birth = births.get(id);
    if (!state || !birth) continue;

    if (pending.has(id)) {
      result.kept.push(id);
      result.records.push(...recordsFor(records, id));
    } else {
      result.folded.push(id);
      result.records.push(decisionCheckpoint(birth, state));
    }
  }

  return result;
}

/** One line per ledger, for `compact` and for the tail of a push that compacted something. */
export function describeCompaction(
  kind: string,
  before: number,
  result: CompactionResult,
): string {
  const after = result.records.length;
  return (
    `${kind}: ${before} records -> ${after} ` +
    `(${result.dropped.length} finished entries dropped, ` +
    `${result.folded.length} folded, ${result.kept.length} pending kept)`
  );
}

/** One JSONL line per record, which is the form the ledger is stored in. */
export function serializeLedger(records: readonly LedgerRecord[]): string {
  return records.map((record) => JSON.stringify(record) + '\n').join('');
}

/**
 * Whether rewriting the ledger with these records would change a byte.
 *
 * Compares the serialized form rather than the counts, because compacting an already-compacted
 * ledger folds every entry again and produces an identical file. Counting that as a change would
 * rewrite the ledger on every push forever, which is the same shape of bug as a `synced` record
 * that never suppresses its own op.
 */
export function compactionIsNoop(
  before: readonly LedgerRecord[],
  result: CompactionResult,
): boolean {
  return serializeLedger(before) === serializeLedger(result.records);
}
