/**
 * Bringing an existing board up to the schema the index needs.
 *
 * A one-time migration in shape, but it ships as a verb because every install created before the
 * `Scope`, `Under`, `Surface`, `Filed`, and `Chat` columns existed faces exactly this. It reads
 * the LOCAL ledger and writes the BOARD, which is the opposite direction from everything else in
 * this package, and it works only while the local ledger is still complete.
 *
 * Entirely pure. It decides what to write and never writes.
 */

import type { BoardEntry } from './board-projection.mjs';
import { areaForSurface, joinListField } from './project-shape.mjs';
import type { LedgerKind } from './project-shape.mjs';

/** What the local ledger knows about one entry, which is the source for this migration. */
export interface LocalEntry {
  id: string;
  title: string;
  surface: string;
  date: string;
  chat: string | null;
  scope: string[];
  under: string | null;
}

export type BackfillOp =
  /**
   * Give an item its entry marker. Decision drafts have never had one, because `appendMarker` is
   * only reached from the issue paths, so on this repo's board this fires 41 times and is what
   * makes every other op addressable on a later run.
   */
  | { op: 'append-marker'; itemId: string; entryId: string; body: string }
  | {
      op: 'set-field';
      itemId: string;
      entryId: string;
      field: string;
      value: string;
    };

export interface BackfillPlan {
  ops: BackfillOp[];
  /** Board item ids with no local counterpart. Skipped, never guessed at. */
  unmatched: string[];
  /**
   * Titles that match more than one local entry, so an unmarked item cannot be resolved to one.
   *
   * Reported rather than resolved. Before markers exist, title is the only shared key between a
   * draft and its ledger entry, and picking one of two identical titles at random would attach
   * every later op to the wrong decision.
   */
  ambiguous: string[];
}

/**
 * The writes that would bring `board` in line with `local`.
 *
 * Matching is by marker where an item has one and by exact title where it does not. That
 * asymmetry is the whole difficulty: the items this migration exists for are precisely the ones
 * with no marker yet.
 *
 * Idempotent by construction. A field already holding the right value emits no op, so a second
 * run returns an empty plan and the caller can report "nothing to do" rather than rewriting 41
 * drafts on every push.
 */
export function planBackfill(
  kind: LedgerKind,
  local: readonly LocalEntry[],
  board: readonly BoardEntry[],
): BackfillPlan {
  const localById = new Map(local.map((entry) => [entry.id, entry]));
  const localByTitle = new Map<string, LocalEntry[]>();
  for (const entry of local) {
    const bucket = localByTitle.get(entry.title);
    if (bucket) bucket.push(entry);
    else localByTitle.set(entry.title, [entry]);
  }

  const ops: BackfillOp[] = [];
  const unmatched: string[] = [];
  const ambiguous = new Set<string>();

  for (const item of board) {
    const match = matchLocalEntry(item, localById, localByTitle);

    if (match.status === 'unmatched') {
      unmatched.push(item.itemId);
      continue;
    }
    if (match.status === 'ambiguous') {
      ambiguous.add(item.title);
      continue;
    }

    if (item.id === '') {
      ops.push({
        op: 'append-marker',
        itemId: item.itemId,
        entryId: match.entry.id,
        body: item.body,
      });
    }

    ops.push(...fieldOps(kind, item, match.entry));
  }

  return { ops, unmatched, ambiguous: Array.from(ambiguous) };
}

/**
 * The local entry a board item resolves to, when it resolves to exactly one.
 *
 * By marker id when the item carries one, otherwise by exact title. Matching by title returns
 * `'ambiguous'` rather than picking a candidate, since a wrong pick would attach every later op
 * to the wrong decision.
 */
type MatchResult =
  | { status: 'matched'; entry: LocalEntry }
  | { status: 'unmatched' }
  | { status: 'ambiguous' };

function matchLocalEntry(
  item: BoardEntry,
  localById: Map<string, LocalEntry>,
  localByTitle: Map<string, LocalEntry[]>,
): MatchResult {
  if (item.id !== '') {
    const entry = localById.get(item.id);
    return entry ? { status: 'matched', entry } : { status: 'unmatched' };
  }

  const candidates = localByTitle.get(item.title) ?? [];
  if (candidates.length === 0) return { status: 'unmatched' };
  if (candidates.length > 1) return { status: 'ambiguous' };
  // candidates.length === 1 here, since the 0 and >1 cases returned above.
  return { status: 'matched', entry: candidates[0]! };
}

/** The `set-field` ops that bring `item` in line with `entry`, for one ledger kind. */
function fieldOps(
  kind: LedgerKind,
  item: BoardEntry,
  entry: LocalEntry,
): BackfillOp[] {
  const ops: BackfillOp[] = [];

  if (kind === 'backlog') {
    setFieldIfDifferent(ops, item, entry.id, 'Filed', item.date, entry.date);
    setFieldIfDifferent(ops, item, entry.id, 'Chat', item.chat, entry.chat);
    setFieldIfDifferent(
      ops,
      item,
      entry.id,
      'Area',
      areaForSurface(item.surface),
      areaForSurface(entry.surface),
    );
    return ops;
  }

  setFieldIfDifferent(ops, item, entry.id, 'Decided', item.date, entry.date);
  setFieldIfDifferent(ops, item, entry.id, 'Chat', item.chat, entry.chat);
  setFieldIfDifferent(
    ops,
    item,
    entry.id,
    'Area',
    areaForSurface(item.surface),
    areaForSurface(entry.surface),
  );
  setFieldIfDifferent(ops, item, entry.id, 'Under', item.under, entry.under);
  setFieldIfDifferent(
    ops,
    item,
    entry.id,
    'Scope',
    joinListField(item.scope),
    entry.scope.length === 0 ? null : joinListField(entry.scope),
  );

  return ops;
}

/**
 * Appends a `set-field` op when `nextValue` differs from `currentValue`.
 *
 * A null `nextValue` is skipped rather than written, so a local field the ledger never
 * collected does not blank out whatever the board already holds.
 */
function setFieldIfDifferent(
  ops: BackfillOp[],
  item: BoardEntry,
  entryId: string,
  field: string,
  currentValue: string | null,
  nextValue: string | null,
): void {
  if (nextValue === null) return;
  if (nextValue === currentValue) return;
  ops.push({
    op: 'set-field',
    itemId: item.itemId,
    entryId,
    field,
    value: nextValue,
  });
}

/** One line per op, for `backfill --dry-run`. */
export function describeBackfillOp(op: BackfillOp): string {
  if (op.op === 'append-marker') {
    return `append entry marker for ${op.entryId}`;
  }
  return `set ${op.field} for ${op.entryId}`;
}

/** Whether applying this plan would change nothing on the board. */
export function backfillIsNoop(plan: BackfillPlan): boolean {
  return plan.ops.length === 0;
}
