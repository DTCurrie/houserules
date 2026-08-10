/**
 * What a `push` would send, decided from the ledgers alone.
 *
 * Entirely pure, like {@link bootstrap-plan}. The executor in `projects-sync.mts` cannot be unit
 * tested by direct import, so every decision about what to push and in what order lives here
 * where it can be.
 *
 * The queue is incremental. A `synced` record in the ledger records that an entry reached the
 * board and carries the issue number or draft item id it landed as, so a second push over the
 * same ledger produces an empty queue. That record is appended by the executor, never here.
 */

import type { LedgerKind } from './project-shape.mjs';
import type { LedgerEntry } from '@agent-kit/payload/ledger-index';

/** The board `Status` values that mean an entry is finished, per kind. */
const CLOSED_BACKLOG_STATUS = 'Done';
const SUPERSEDED_DECISION_STATUS = 'Superseded';

/** One line of either ledger, loosely typed because both shapes flow through this module. */
export interface LedgerRecord {
  ts: string;
  id: string;
  action: string;
  file?: string;
  title?: string;
  reason?: string;
  chat?: string | null;
  content?: string;
  supersedes?: string[];
  scope?: string[];
  /** Set by the executor's own `synced` record, and by an entry adopted from an issue. */
  issue?: number;
  /** Set by the executor's `synced` record for a decision draft. */
  itemId?: string;
  /**
   * Which operation a `synced` record acknowledges.
   *
   * A superseded decision accumulates two of them, one for the draft that created it and one for
   * the flip to Superseded, and they are otherwise identical. Without this the flip is re-emitted
   * on every push forever. Records written before this field existed carry no `op` and are read
   * as the draft, which is what they were.
   */
  op?: string;
}

/**
 * A backlog entry born attached to an existing issue, which `/backlog-adopt` produces in phase 5.
 *
 * Modeled now rather than special-cased later. Such an entry must never have an issue created
 * for it, and its body must never overwrite the reporter's.
 */
export interface PushOpBase {
  entryId: string;
  kind: LedgerKind;
  /** The ledger-dir-relative surface the entry belongs to, which becomes the item's `Area`. */
  surface: string;
  title: string;
  body: string;
  /**
   * The day the entry was filed, which the board keeps as `Filed` or `Decided`.
   *
   * On the base rather than per op because both ledgers need it and an item's own `Created` is a
   * different date, often much later. An entry pushed without it reads `????-??-??` once the
   * queue drains and the index is the only source left.
   */
  date: string;
  chat: string | null;
}

export type PushOp =
  | (PushOpBase & { op: 'create-issue' })
  | (PushOpBase & { op: 'attach-issue'; issue: number })
  | (PushOpBase & { op: 'update-issue'; issue: number })
  | (PushOpBase & { op: 'close-issue'; issue: number; reason: string })
  | (PushOpBase & {
      op: 'create-draft';
      supersedes: string[];
      scope: string[];
    })
  | (PushOpBase & { op: 'update-draft'; itemId: string; scope: string[] })
  /**
   * Flips an existing decision item to Superseded and names what replaced it.
   *
   * `itemId` is null when the superseded record is created by an earlier op in this same queue,
   * which is the ordinary case on a first push: nothing is synced yet, so every superseded
   * decision is created and then flipped in one run. The executor resolves a null against the
   * ids it recorded earlier in the same run.
   *
   * Emitting this only for already-synced targets was the first design and it was wrong. A first
   * push left every superseded decision reading Accepted, and the second push builds an empty
   * queue, so nothing would ever have corrected it.
   */
  | (PushOpBase & {
      op: 'mark-superseded';
      itemId: string | null;
      successorId: string;
    })
  /**
   * An entry whose surface changed after it was already synced.
   *
   * With one board per ledger this never moves an item between boards. It re-files it in place by
   * setting `Area`, which is what scopes an item now. The entry keeps its issue number and its
   * comment history, which people link to.
   */
  | (PushOpBase & {
      op: 'report-move';
      issue: number | null;
      /** The draft's board item id, for a decision, which has no issue to find it by. */
      itemId: string | null;
      toSurface: string;
    });

/** What `status` prints and what the SessionEnd hook checks before spawning anything. */
export interface QueueSummary {
  backlogPending: number;
  decisionsPending: number;
}

export interface BacklogState {
  file: string;
  title: string;
  content: string;
  date: string;
  chat: string | null;
  issue: number | undefined;
  synced: boolean;
  syncedIssue: number | undefined;
  removed: boolean;
  removeReason: string;
  /**
   * Whether the close for this entry already reached the board.
   *
   * Tracked separately from `synced`, which only says the issue exists. A removed entry carries
   * two `synced` records, one for the issue that created it and one for the close, and without
   * telling them apart the close is re-emitted on every push forever.
   */
  closed: boolean;
  contentDirty: boolean;
  fileDirty: boolean;
}

function newBacklogState(r: LedgerRecord): BacklogState {
  // `issue` here is always an adoption: an issue that exists and has not been attached yet. An
  // entry that already reached the board is seeded from the index instead, never from a record.
  return {
    file: r.file ?? '',
    title: r.title ?? '',
    content: r.content ?? '',
    date: r.ts.slice(0, 10),
    chat: r.chat ?? null,
    issue: r.issue,
    synced: false,
    syncedIssue: undefined,
    removed: false,
    removeReason: '',
    closed: false,
    contentDirty: false,
    fileDirty: false,
  };
}

/**
 * `next` carrying whatever `seeded` already knew about the board.
 *
 * A birth record replaces an entry's CONTENT, because the queue is newer than the index. It must
 * not replace where the entry already is, or an entry the board holds looks unsynced and is
 * created a second time. That is not hypothetical: it duplicated 43 decision drafts on the live
 * board the first time this fold seeded from an index.
 */
function withBacklogSyncState(
  next: BacklogState,
  seeded: BacklogState | undefined,
): BacklogState {
  if (!seeded?.synced) return next;
  return {
    ...next,
    synced: true,
    syncedIssue: seeded.syncedIssue,
    closed: seeded.closed,
  };
}

function withDecisionSyncState(
  next: DecisionState,
  seeded: DecisionState | undefined,
): DecisionState {
  if (!seeded?.synced) return next;
  return {
    ...next,
    synced: true,
    syncedItemId: seeded.syncedItemId,
    markedSuperseded: seeded.markedSuperseded,
    contentDirty: next.content !== seeded.content,
    scopeDirty: JSON.stringify(next.scope) !== JSON.stringify(seeded.scope),
    fileDirty: next.file !== seeded.file,
  };
}

function applyBacklogRecord(
  entries: Map<string, BacklogState>,
  r: LedgerRecord,
): void {
  const state = entries.get(r.id);
  if (!state) return;
  if (r.action === 'update') {
    if (r.title !== undefined) state.title = r.title;
    if (r.content !== undefined) state.content = r.content;
    if (state.synced) state.contentDirty = true;
  } else if (r.action === 'move') {
    if (r.file !== undefined) state.file = r.file;
    if (state.synced) state.fileDirty = true;
  } else if (r.action === 'remove') {
    state.removed = true;
    state.removeReason = r.reason ?? '';
  } else if (r.action === 'synced') {
    if (r.op === 'close-issue') {
      state.closed = true;
      return;
    }
    state.synced = true;
    state.syncedIssue = r.issue;
    state.contentDirty = false;
    state.fileDirty = false;
  }
}

function backlogOpsFor(id: string, state: BacklogState): PushOp[] {
  const base = {
    entryId: id,
    kind: 'backlog' as const,
    surface: state.file,
    title: state.title,
    body: state.content,
    date: state.date,
    chat: state.chat,
  };

  if (state.removed) {
    if (!state.synced || state.closed) return [];
    return [
      {
        ...base,
        op: 'close-issue' as const,
        issue: state.syncedIssue!,
        reason: state.removeReason,
      },
    ];
  }

  if (!state.synced) {
    if (state.issue !== undefined) {
      return [{ ...base, op: 'attach-issue' as const, issue: state.issue }];
    }
    return [{ ...base, op: 'create-issue' as const }];
  }

  const ops: PushOp[] = [];
  if (state.contentDirty) {
    ops.push({
      ...base,
      op: 'update-issue' as const,
      issue: state.syncedIssue!,
    });
  }
  if (state.fileDirty) {
    ops.push({
      ...base,
      op: 'report-move' as const,
      issue: state.syncedIssue!,
      itemId: null,
      toSurface: state.file,
    });
  }
  return ops;
}

/**
 * Whether this entry was removed before any push ever reached the board.
 *
 * It has nothing on the board to close, so `backlogOpsFor` returns nothing for it and nothing can
 * revive it, because `remove` has no inverse. It is dead weight in the ledger forever, and it is
 * the whole of the ledger's unbounded growth: a repo that files and drops entries locally
 * accumulates them at the rate it works.
 *
 * Deliberately NOT true of an entry whose close already landed, which is equally finished. That
 * one has a board copy, so compaction defers to the index to confirm the copy exists before
 * dropping the local record of it. An entry that never synced has no board copy to confirm, so
 * the index can never say anything about it and waiting for confirmation keeps it forever.
 */
export function isRemovedBeforeSync(state: BacklogState): boolean {
  return state.removed && !state.synced;
}

/**
 * Every backlog entry's final state, in first-`add` order.
 *
 * Exported so compaction decides what to drop from the same fold the queue is built from. Two
 * folds of one ledger would drift, and the drift would show up as an entry that compaction
 * believes is finished and push believes is pending.
 */
function backlogStateFromIndex(entry: LedgerEntry): BacklogState {
  const closed = entry.status === CLOSED_BACKLOG_STATUS;
  return {
    file: entry.surface,
    title: entry.title,
    content: entry.body,
    date: entry.date,
    chat: entry.chat,
    issue: undefined,
    synced: true,
    syncedIssue: entry.issue ?? undefined,
    removed: closed,
    removeReason: '',
    closed,
    contentDirty: false,
    fileDirty: false,
  };
}

export function foldBacklog(
  records: readonly LedgerRecord[],
  index: readonly LedgerEntry[] = [],
): {
  entries: Map<string, BacklogState>;
  order: string[];
} {
  const entries = new Map<string, BacklogState>();
  const order: string[] = [];

  for (const entry of index) {
    entries.set(entry.id, backlogStateFromIndex(entry));
    order.push(entry.id);
  }

  for (const r of records) {
    if (r.action === 'add') {
      entries.set(
        r.id,
        withBacklogSyncState(newBacklogState(r), entries.get(r.id)),
      );
      if (!order.includes(r.id)) order.push(r.id);
      continue;
    }
    applyBacklogRecord(entries, r);
  }

  return { entries, order };
}

function buildBacklogQueue(
  records: readonly LedgerRecord[],
  index: readonly LedgerEntry[],
): PushOp[] {
  const { entries, order } = foldBacklog(records, index);
  return order.flatMap((id) => backlogOpsFor(id, entries.get(id)!));
}

export interface DecisionState {
  file: string;
  title: string;
  content: string;
  decided: string;
  supersedesList: string[];
  chat: string | null;
  scope: string[];
  synced: boolean;
  syncedItemId: string | undefined;
  /**
   * Whether a `mark-superseded` for this record already reached the board.
   *
   * Tracked separately from `synced`, which only says the item exists. A superseded decision
   * carries two `synced` records, one for the draft that created it and one for the flip, and
   * without telling them apart the flip is re-emitted on every push forever.
   */
  markedSuperseded: boolean;
  contentDirty: boolean;
  scopeDirty: boolean;
  fileDirty: boolean;
}

function newDecisionState(r: LedgerRecord): DecisionState {
  return {
    file: r.file ?? '',
    title: r.title ?? '',
    content: r.content ?? '',
    decided: r.ts.slice(0, 10),
    supersedesList: r.supersedes ?? [],
    chat: r.chat ?? null,
    scope: r.scope ?? [],
    synced: false,
    syncedItemId: undefined,
    markedSuperseded: false,
    contentDirty: false,
    scopeDirty: false,
    fileDirty: false,
  };
}

function applyDecisionRecord(
  entries: Map<string, DecisionState>,
  r: LedgerRecord,
): void {
  const state = entries.get(r.id);
  if (!state) return;
  if (r.action === 'amend') {
    if (r.content !== undefined) state.content = r.content;
    if (state.synced) state.contentDirty = true;
  } else if (r.action === 'move') {
    if (r.file !== undefined) state.file = r.file;
    if (state.synced) state.fileDirty = true;
  } else if (r.action === 'rescope') {
    if (r.scope !== undefined) state.scope = r.scope;
    if (state.synced) state.scopeDirty = true;
  } else if (r.action === 'synced') {
    if (r.op === 'mark-superseded') {
      state.markedSuperseded = true;
      return;
    }
    state.synced = true;
    state.syncedItemId = r.itemId;
    state.contentDirty = false;
    state.scopeDirty = false;
    state.fileDirty = false;
  }
}

function decisionPrimaryOps(id: string, state: DecisionState): PushOp[] {
  const base = {
    entryId: id,
    kind: 'decisions' as const,
    surface: state.file,
    title: state.title,
    body: state.content,
    date: state.decided,
    chat: state.chat,
  };

  if (!state.synced) {
    return [
      {
        ...base,
        op: 'create-draft' as const,
        supersedes: state.supersedesList,
        scope: state.scope,
      },
    ];
  }

  const ops: PushOp[] = [];
  if (state.contentDirty || state.scopeDirty) {
    ops.push({
      ...base,
      op: 'update-draft' as const,
      itemId: state.syncedItemId!,
      scope: state.scope,
    });
  }
  if (state.fileDirty) {
    ops.push({
      ...base,
      op: 'report-move' as const,
      issue: null,
      itemId: state.syncedItemId ?? null,
      toSurface: state.file,
    });
  }
  return ops;
}

/**
 * A `mark-superseded` op for each target id that resolves to a decision somewhere in this
 * ledger, read off the target's FINAL state rather than its state when the `supersede` record
 * was written.
 *
 * A target's `move` or `synced` record can land anywhere later in the ledger, so reading its
 * state mid-pass carries a stale surface or a missing item id. `itemId` is null only when the
 * target genuinely has no synced record by the end of the ledger, the true first-push case the
 * executor resolves from its own run. A target absent from the ledger entirely has no decision
 * to mark at all.
 */
function markSupersededOps(
  entries: Map<string, DecisionState>,
  successorId: string,
  targets: readonly string[],
): PushOp[] {
  const ops: PushOp[] = [];
  for (const targetId of targets) {
    const target = entries.get(targetId);
    if (!target || target.markedSuperseded) continue;
    ops.push({
      entryId: targetId,
      kind: 'decisions',
      surface: target.file,
      title: target.title,
      body: target.content,
      date: target.decided,
      chat: target.chat,
      op: 'mark-superseded',
      itemId: target.synced ? (target.syncedItemId ?? null) : null,
      successorId,
    });
  }
  return ops;
}

/**
 * Every decision's final state, in first-birth order, with the supersede targets each one names.
 *
 * The counterpart to {@link foldBacklog}, and exported for the same reason. A decision is never
 * terminal: a synced, unedited one emits nothing, but `markSupersededOps` still resolves supersede
 * targets out of this map, so dropping one would silently strand a later flip.
 */
function decisionStateFromIndex(entry: LedgerEntry): DecisionState {
  return {
    file: entry.surface,
    title: entry.title,
    content: entry.body,
    decided: entry.date,
    supersedesList: entry.supersedes,
    chat: entry.chat,
    scope: entry.scope,
    synced: true,
    syncedItemId: entry.itemId || undefined,
    markedSuperseded: entry.status === SUPERSEDED_DECISION_STATUS,
    contentDirty: false,
    scopeDirty: false,
    fileDirty: false,
  };
}

export function foldDecisions(
  records: readonly LedgerRecord[],
  index: readonly LedgerEntry[] = [],
): {
  entries: Map<string, DecisionState>;
  order: string[];
  pendingTargets: Map<string, string[]>;
} {
  const entries = new Map<string, DecisionState>();
  const order: string[] = [];
  const pendingTargets = new Map<string, string[]>();

  for (const entry of index) {
    entries.set(entry.id, decisionStateFromIndex(entry));
    order.push(entry.id);
  }

  for (const r of records) {
    if (r.action === 'decide' || r.action === 'supersede') {
      entries.set(
        r.id,
        withDecisionSyncState(newDecisionState(r), entries.get(r.id)),
      );
      if (!order.includes(r.id)) order.push(r.id);
      if (r.action === 'supersede') {
        pendingTargets.set(r.id, r.supersedes ?? []);
      }
      continue;
    }
    applyDecisionRecord(entries, r);
  }

  return { entries, order, pendingTargets };
}

function buildDecisionsQueue(
  records: readonly LedgerRecord[],
  index: readonly LedgerEntry[],
): PushOp[] {
  const { entries, order, pendingTargets } = foldDecisions(records, index);

  return order.flatMap((id) => [
    ...decisionPrimaryOps(id, entries.get(id)!),
    ...markSupersededOps(entries, id, pendingTargets.get(id) ?? []),
  ]);
}

/**
 * The operations one push should perform, in ledger order.
 *
 * Ledger order matters: a decision's `supersede` has to reach the board after the record it
 * supersedes, or the `mark-superseded` op names an item that does not exist yet.
 *
 * @param backlog Every record from the backlog queue, in append order.
 * @param decisions Every record from the decision queue, in append order.
 * @param backlogIndex The board's own backlog entries, which seed state for anything already
 *   synced. Empty means no index, which is a fresh clone and not an error.
 * @param decisionsIndex The same for decisions.
 */
export function buildPushQueue(
  backlog: readonly LedgerRecord[],
  decisions: readonly LedgerRecord[],
  backlogIndex: readonly LedgerEntry[] = [],
  decisionsIndex: readonly LedgerEntry[] = [],
): PushOp[] {
  return [
    ...buildBacklogQueue(backlog, backlogIndex),
    ...buildDecisionsQueue(decisions, decisionsIndex),
  ];
}

/** Pending counts per ledger, without building the full queue. */
export function summarizeQueue(ops: readonly PushOp[]): QueueSummary {
  let backlogPending = 0;
  let decisionsPending = 0;
  for (const op of ops) {
    if (op.op === 'report-move') continue;
    if (op.kind === 'backlog') backlogPending++;
    else decisionsPending++;
  }
  return { backlogPending, decisionsPending };
}

/**
 * The `synced` record the executor appends once an operation lands.
 *
 * Its `action` is deliberately not one either ledger script's projection handles, so appending
 * it changes nothing about how a surface renders. Confirm that before relying on it: both
 * `projectBacklog` and `projectDecisions` fall through an unknown action.
 */
export function syncedRecord(
  op: PushOp,
  result: { issue?: number; itemId?: string },
  timestamp: string,
): Record<string, unknown> {
  return {
    action: 'synced',
    id: op.entryId,
    op: op.op,
    ts: timestamp,
    ...(result.issue !== undefined ? { issue: result.issue } : {}),
    ...(result.itemId !== undefined ? { itemId: result.itemId } : {}),
  };
}
