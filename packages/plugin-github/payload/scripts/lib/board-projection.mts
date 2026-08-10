/**
 * Rebuilding a ledger entry from what a project board holds.
 *
 * The inverse of the push path, and the module the whole queue-and-index split rests on. If this
 * cannot reconstruct an entry, the local `.jsonl` can never be emptied, because the board would
 * not hold enough to answer a query.
 *
 * Entirely pure. It takes already-fetched GraphQL nodes and returns entries. Fetching, paginating,
 * and writing are somebody else's job.
 */

import {
  formatMarker,
  parseMarker,
  splitListField,
  surfaceForArea,
} from './project-shape.mjs';
import type { LedgerKind } from './project-shape.mjs';
import type { LedgerEntry } from '@agent-kit/payload/ledger-index';

/** One `fieldValues` node, narrowed to the value shapes the boards use. */
export interface BoardFieldValue {
  __typename: string;
  field?: { name: string };
  text?: string;
  date?: string;
  name?: string;
  number?: number;
}

/** One `items` node, narrowed to what a projection reads. */
export interface BoardItem {
  id: string;
  content: {
    __typename: string;
    number?: number;
    title?: string;
    body?: string;
    state?: string;
  } | null;
  fieldValues: { nodes: BoardFieldValue[] };
}

/**
 * One ledger entry as the board describes it.
 *
 * The core type under a local name, because here it is what a project board holds and in core it
 * is a ledger entry. Imported as a TYPE by package name, `@agent-kit/payload/ledger-index`, which
 * is the only supported way a payload lib reaches core substrate: `agent-kit-payload` rewrites
 * that specifier to the relative path the flattened `.claude/scripts/lib/` layout needs.
 *
 * The import erases before emit, so the payload keeps its zero runtime dependencies by
 * construction rather than by exception. A VALUE from core still cannot be imported here, and a
 * lib that needs one takes it as a parameter from the script that called it.
 */
export type BoardEntry = LedgerEntry;

export interface BoardProjection {
  /** Items carrying an entry marker. The index reads these. */
  entries: BoardEntry[];
  /**
   * Items with content but no marker, projected with `id: ''`.
   *
   * Backfill reads these and resolves each to a local entry by title, which is the only shared
   * key before a marker exists. The index ignores them, because an unmarked item is not ours.
   */
  unmarked: BoardEntry[];
  /** Item ids with no content at all, which cannot be projected either way. */
  skipped: string[];
}

/** The value of one named field on an item, or null when the item has no value for it. */
export function fieldValue(item: BoardItem, name: string): string | null {
  // `node.field` is optional in practice, not just in the type. A GraphQL union member the query
  // did not spread a `field` fragment onto comes back as a bare `{__typename}`, which crashed this
  // on the first issue-backed board it met: GitHub adds a default Repository field to those.
  // The query now covers every member, and this guard is what keeps a future one from crashing a
  // hook rather than being ignored.
  const match = item.fieldValues.nodes.find(
    (node) => node.field?.name === name,
  );
  if (!match) return null;
  if (match.text !== undefined) return match.text;
  if (match.date !== undefined) return match.date;
  if (match.name !== undefined) return match.name;
  if (match.number !== undefined) return String(match.number);
  return null;
}

/** `body` without its entry marker or the blank line `appendMarker` put before it. */
export function stripMarker(body: string): string {
  const id = parseMarker(body);
  if (id === null) return body;
  const suffix = `\n\n${formatMarker(id)}`;
  return body.endsWith(suffix) ? body.slice(0, -suffix.length) : body;
}

function projectEntry(
  kind: LedgerKind,
  item: BoardItem,
  id: string,
  body: string,
): BoardEntry {
  return {
    id,
    itemId: item.id,
    issue: kind === 'backlog' ? (item.content?.number ?? null) : null,
    title: item.content?.title ?? '',
    body: stripMarker(body),
    surface: surfaceForArea(fieldValue(item, 'Area') ?? '', kind),
    date: fieldValue(item, kind === 'backlog' ? 'Filed' : 'Decided') ?? '',
    chat: fieldValue(item, 'Chat'),
    status: fieldValue(item, 'Status'),
    scope: kind === 'backlog' ? [] : splitListField(fieldValue(item, 'Scope')),
    under: kind === 'backlog' ? null : fieldValue(item, 'Under'),
    supersedes:
      kind === 'backlog' ? [] : splitListField(fieldValue(item, 'Supersedes')),
    supersededBy: kind === 'backlog' ? null : fieldValue(item, 'Superseded by'),
  };
}

/**
 * Every item with content, rebuilt as a ledger entry.
 *
 * An item carrying an entry marker becomes an `entries` row. An item with content but no
 * marker is projected the same way, with `id: ''`, into `unmarked` rather than discarded.
 * `/backlog-adopt` deliberately puts foreign issues on a board before anyone adopts them, so an
 * unmarked item is an ordinary state, and resolving it to a local entry by title is the caller's
 * job. Only an item with no content at all is unprojectable and lands in `skipped`.
 */
export function projectBoardItems(
  kind: LedgerKind,
  items: readonly BoardItem[],
): BoardProjection {
  const entries: BoardEntry[] = [];
  const unmarked: BoardEntry[] = [];
  const skipped: string[] = [];

  for (const item of items) {
    if (item.content == null) {
      skipped.push(item.id);
      continue;
    }

    const body = item.content.body ?? '';
    const id = parseMarker(body);
    if (id === null) {
      unmarked.push(projectEntry(kind, item, '', body));
      continue;
    }

    entries.push(projectEntry(kind, item, id, body));
  }

  return { entries, unmarked, skipped };
}
