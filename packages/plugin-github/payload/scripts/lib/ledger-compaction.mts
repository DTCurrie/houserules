/**
 * Reducing a ledger to the records that can still change something.
 *
 * The ledgers are a QUEUE. An entry the board holds is removed from them entirely, so a synced
 * repo's `.jsonl` is empty and its size tracks work outstanding rather than work done.
 *
 * Two conditions must BOTH hold before an entry is dropped, and the second is what makes the first
 * safe. The push queue must owe it nothing, and the index must confirm the board actually has it.
 * A push that wrote its `synced` record but whose board write did not land would otherwise eat the
 * only remaining copy.
 *
 * Entirely pure, like {@link push-queue}. It never reads or writes a file, and the executor in
 * `projects-sync.mts` is what applies the result.
 *
 * Two invariants make the rewrite safe, and the executor checks both against real data before it
 * replaces anything:
 *
 * 1. The push queue built from the compacted records equals the one built from the originals.
 *    Compaction must never turn finished work back into pending work, or hide pending work.
 * 2. A surviving entry keeps every record it had, byte for byte. Compaction only ever removes
 *    whole entries, so a field this module has no type for cannot be lost by rewriting one.
 */

import { foldBacklog, foldDecisions } from './push-queue.mjs';
import type { LedgerRecord, PushOp } from './push-queue.mjs';
import type { LedgerEntry } from '@agent-kit/cli/payload/ledger-index';

/** An entry removed outright, identified for a manifest of what compaction dropped. */
export interface DroppedEntry {
  id: string;
  title: string;
}

/** What one ledger's compaction produced, and which entries went which way. */
export interface CompactionResult {
  records: LedgerRecord[];
  /** Entries removed outright, because nothing can ever be pushed for them again. */
  dropped: DroppedEntry[];
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

function recordsFor(
  records: readonly LedgerRecord[],
  id: string,
): LedgerRecord[] {
  return records.filter((record) => record.id === id);
}

export function compactBacklog(
  records: readonly LedgerRecord[],
  pending: ReadonlySet<string>,
  index: readonly LedgerEntry[] = [],
): CompactionResult {
  const { entries, order } = foldBacklog(records);
  const onBoard = new Set(index.map((entry) => entry.id));
  const result: CompactionResult = {
    records: [],
    dropped: [],
    kept: [],
  };

  for (const id of order) {
    const state = entries.get(id);
    if (!state) continue;

    if (pending.has(id) || !onBoard.has(id)) {
      result.kept.push(id);
      result.records.push(...recordsFor(records, id));
      continue;
    }
    result.dropped.push({ id, title: state.title });
  }

  return result;
}

export function compactDecisions(
  records: readonly LedgerRecord[],
  pending: ReadonlySet<string>,
  index: readonly LedgerEntry[] = [],
): CompactionResult {
  const { entries, order } = foldDecisions(records);
  const onBoard = new Set(index.map((entry) => entry.id));
  const result: CompactionResult = {
    records: [],
    dropped: [],
    kept: [],
  };

  for (const id of order) {
    const state = entries.get(id);
    if (!state) continue;

    if (pending.has(id) || !onBoard.has(id)) {
      result.kept.push(id);
      result.records.push(...recordsFor(records, id));
      continue;
    }
    result.dropped.push({ id, title: state.title });
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
    `(${result.dropped.length} on the board and dropped, ` +
    `${result.kept.length} still queued)`
  );
}

/** One JSONL line per record, which is the form the ledger is stored in. */
export function serializeLedger(records: readonly LedgerRecord[]): string {
  return records.map((record) => JSON.stringify(record) + '\n').join('');
}

/**
 * Whether rewriting the ledger with these records would change a byte.
 *
 * Compares the serialized form rather than the counts, so a run that drops nothing writes nothing.
 * Counting differently would rewrite the ledger on every push forever, which is the same shape of
 * bug as a `synced` record that never suppresses its own op.
 */
export function compactionIsNoop(
  before: readonly LedgerRecord[],
  result: CompactionResult,
): boolean {
  return serializeLedger(before) === serializeLedger(result.records);
}
