/**
 * Reducing a ledger to the records that can still change something.
 *
 * The ledgers are a QUEUE. An entry the board holds is removed from them entirely, so a synced
 * repo's `.jsonl` is empty and its size tracks work outstanding rather than work done.
 *
 * The push queue must owe an entry nothing before it can be dropped, and that alone is not enough.
 * One of two further things has to be true. Either the index confirms the board has it, so
 * a push that wrote its `synced` record but whose board write did not land cannot have the only
 * remaining copy eaten. Or the entry never synced at all, in which case there is no board copy for
 * the index to confirm and waiting on confirmation would keep it forever.
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

import {
  foldBacklog,
  foldDecisions,
  isRemovedBeforeSync,
} from './push-queue.mjs';
import type { BacklogState, LedgerRecord, PushOp } from './push-queue.mjs';
import type { LedgerEntry } from '@houserules/payload/ledger-index';

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

/**
 * The fold-agnostic half of compaction: walk the folded order, keep or drop each entry whole.
 *
 * Both ledgers share this. What differs between them is the fold and the survival rule, so those
 * are the two parameters, and neither ledger gets to grow its own copy of the loop.
 *
 * An id that contributed no records is skipped outright rather than counted either way. Folding
 * with the index puts every board entry in `order`, including ones whose records a previous
 * compaction already dropped, and those are neither kept nor dropped by a pass over records.
 * Counting them would inflate both manifests with entries this run did not touch.
 */
function compactLedger<TState extends { title: string }>(
  records: readonly LedgerRecord[],
  fold: { entries: Map<string, TState>; order: readonly string[] },
  survives: (id: string, state: TState) => boolean,
): CompactionResult {
  const result: CompactionResult = {
    records: [],
    dropped: [],
    kept: [],
  };

  for (const id of fold.order) {
    const state = fold.entries.get(id);
    if (!state) continue;

    const own = recordsFor(records, id);
    if (own.length === 0) continue;

    if (survives(id, state)) {
      result.kept.push(id);
      result.records.push(...own);
      continue;
    }
    result.dropped.push({ id, title: state.title });
  }

  return result;
}

/**
 * Whether every record for this backlog entry must survive the rewrite.
 *
 * Three cases, and their ORDER is load-bearing. `pending` comes from the caller rather than from
 * this fold, so the two can disagree about one entry, and the queue is the half that must win. It
 * is the invariant the executor checks before it rewrites anything. Asking the local state first
 * would let a fold that reads an entry as finished delete the records an op in the queue is built
 * from.
 */
function backlogEntrySurvives(
  id: string,
  state: BacklogState,
  pending: ReadonlySet<string>,
  onBoard: ReadonlySet<string>,
): boolean {
  if (pending.has(id)) return true;
  if (isRemovedBeforeSync(state)) return false;
  return !onBoard.has(id);
}

export function compactBacklog(
  records: readonly LedgerRecord[],
  pending: ReadonlySet<string>,
  index: readonly LedgerEntry[] = [],
): CompactionResult {
  const onBoard = new Set(index.map((entry) => entry.id));

  return compactLedger(records, foldBacklog(records, index), (id, state) =>
    backlogEntrySurvives(id, state, pending, onBoard),
  );
}

/**
 * No decisions counterpart to {@link isRemovedBeforeSync}, because a decision is never terminal.
 * It has no `remove`, and `markSupersededOps` resolves supersede targets out of the same fold, so
 * an entry that emits nothing itself can still be named by a later flip.
 */
export function compactDecisions(
  records: readonly LedgerRecord[],
  pending: ReadonlySet<string>,
  index: readonly LedgerEntry[] = [],
): CompactionResult {
  const onBoard = new Set(index.map((entry) => entry.id));

  return compactLedger(
    records,
    foldDecisions(records, index),
    (id) => pending.has(id) || !onBoard.has(id),
  );
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
    `(${result.dropped.length} finished and dropped, ` +
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
