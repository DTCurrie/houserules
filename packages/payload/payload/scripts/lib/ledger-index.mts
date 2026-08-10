import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** The two ledgers the kit keeps. */
export type LedgerKind = 'backlog' | 'decisions';

/**
 * One ledger entry, fully resolved.
 *
 * The shape every reader works in, whichever half it came from. It lives here rather than beside
 * the code that fetches it because three packages consume it and none of them is the one that
 * talks to GitHub: `decision-log`, `backlog-log`, and this package's own `ledger-inject`. Core
 * owning the FORMAT is core owning an interface, per `AGENTKIT-116e0c`, and the dependency arrow
 * still points from plugin to core.
 *
 * A backlog entry leaves `scope`, `under`, `supersedes`, and `supersededBy` empty. A decision
 * leaves `issue` null. `itemId` and `status` are empty for an entry that has not reached a board.
 */
export interface LedgerEntry {
  id: string;
  itemId: string;
  issue: number | null;
  title: string;
  body: string;
  surface: string;
  date: string;
  chat: string | null;
  status: string | null;
  scope: string[];
  under: string | null;
  supersedes: string[];
  supersededBy: string | null;
}

/**
 * Bumped whenever the stored shape changes.
 *
 * An index written by an older version is discarded rather than migrated. It costs one `pull` to
 * rebuild and a migration path for a cache is work that buys nothing.
 */
export const INDEX_VERSION = 1;

export interface LedgerIndex {
  version: number;
  kind: LedgerKind;
  /** ISO timestamp of the pull that produced this file, so staleness is visible. */
  pulledAt: string;
  /** The board numbers this was built from. A changed board set means the index is incomplete. */
  projects: number[];
  entries: LedgerEntry[];
}

/** The file one kind's index lives in, inside the ledger directory. */
export function indexBasename(kind: LedgerKind): string {
  return `${kind}.index.json`;
}

export function emptyIndex(kind: LedgerKind, pulledAt: string): LedgerIndex {
  return { version: INDEX_VERSION, kind, pulledAt, projects: [], entries: [] };
}

export function serializeIndex(index: LedgerIndex): string {
  return `${JSON.stringify(index, null, 2)}\n`;
}

/**
 * The index in `raw`, or null when it cannot be trusted.
 *
 * **Never throws, for any input.** `ledger-inject.mjs` reads this on every prompt as a
 * `UserPromptSubmit` hook, and a hook that throws costs the user their turn. A truncated write, a
 * hand-edit, or an index from a future version all return null, and null means "no cache", which
 * every caller already has to handle for a fresh clone.
 */
export function parseIndex(raw: string, kind: LedgerKind): LedgerIndex | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) return null;

  const candidate = parsed as Partial<LedgerIndex>;
  if (candidate.version !== INDEX_VERSION) return null;
  if (candidate.kind !== kind) return null;
  if (!Array.isArray(candidate.entries)) return null;

  return candidate as LedgerIndex;
}

/**
 * The index for `kind` in `ledgerDirectory`, or null when there is not a usable one.
 *
 * **Never throws, for any state of the disk.** Null covers every failure the same way: no file, an
 * unreadable file, a truncated write, a hand-edit, a version from the future. Callers already have
 * to handle null for a fresh clone that has never pulled, so there is no second path to get wrong.
 * `ledger-inject.mjs` calls this on every prompt, and a hook that throws costs the user their turn.
 *
 * This index is the other half of the queue-and-index split: the `.jsonl` ledgers hold what has
 * not reached a board yet, and this index is a projection of the boards so `scope`, `show`, and
 * prompt injection answer instantly and offline. It is a CACHE and never a record of truth.
 * Deleting it loses nothing a `pull` cannot rebuild, so nothing that cannot be rebuilt from a
 * board belongs in it. This function is the one read every consumer needs, kept here rather than
 * copied into each of them. Writing the file stays the sync plugin's job.
 */
export function loadIndex(
  ledgerDirectory: string,
  kind: LedgerKind,
): LedgerIndex | null {
  const path = resolve(ledgerDirectory, indexBasename(kind));
  if (!existsSync(path)) return null;
  try {
    return parseIndex(readFileSync(path, 'utf8'), kind);
  } catch {
    return null;
  }
}

/** The entry for `id`, or null. The lookup prompt injection and `show` are built on. */
export function findEntry(
  index: LedgerIndex | null,
  id: string,
): LedgerEntry | null {
  if (index === null) return null;
  return index.entries.find((entry) => entry.id === id) ?? null;
}

/**
 * Merges an index with the queue's own entries, queue winning on any id in both.
 *
 * The queue is newer than the index by construction: it holds what has not been pushed, which
 * includes edits to entries the board already has. An index-first merge would show a stale body
 * for an entry someone just revised.
 */
export function mergeWithQueue(
  index: LedgerIndex | null,
  queued: readonly LedgerEntry[],
): LedgerEntry[] {
  if (index === null) return [...queued];

  const queuedById = new Map(queued.map((entry) => [entry.id, entry]));
  const seenIds = new Set<string>();

  const merged = index.entries.map((entry) => {
    seenIds.add(entry.id);
    return queuedById.get(entry.id) ?? entry;
  });

  for (const entry of queued) {
    if (!seenIds.has(entry.id)) merged.push(entry);
  }

  return merged;
}
