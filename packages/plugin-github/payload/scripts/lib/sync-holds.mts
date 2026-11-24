import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/**
 * Ledger entries a push holds back, because a row for them was written in a turn where the user
 * rejected a tool use.
 *
 * Both maps key an entry id to the `ts` of the newest row they cover. `released` remembers what
 * `release` cleared, so a session that ends again after `/resume` does not hold the same row a
 * second time. A row written after the release is newer than the recorded `ts` and is held.
 */
export interface SyncHolds {
  held: Record<string, string>;
  released: Record<string, string>;
}

/** Where the holds live, beside `projects-sync.log` and the push lock. */
export function holdsPath(root: string): string {
  return resolve(root, '.claude/state/projects-sync-holds.json');
}

function emptyHolds(): SyncHolds {
  return { held: {}, released: {} };
}

function stringMap(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return {};
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value))
    if (typeof entry === 'string') out[key] = entry;
  return out;
}

/** The holds at `path`, or none when the file is missing or unreadable. */
export function readHolds(path: string): SyncHolds {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<SyncHolds>;
    return {
      held: stringMap(parsed.held),
      released: stringMap(parsed.released),
    };
  } catch {
    return emptyHolds();
  }
}

/** Writes `holds` through a temp file and a rename, so a reader never sees half a file. */
export function writeHolds(path: string, holds: SyncHolds): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(holds, null, 2)}\n`);
  renameSync(temporary, path);
}

function isNewer(ts: string, than: string | undefined): boolean {
  return than === undefined || Date.parse(ts) > Date.parse(than);
}

/**
 * `holds` with each of `rows` added. Every id already held keeps its hold, and a row no newer
 * than its id's release is skipped.
 */
export function mergeHolds(
  holds: SyncHolds,
  rows: readonly { id: string; ts: string }[],
): SyncHolds {
  const held = { ...holds.held };
  for (const row of rows) {
    if (!isNewer(row.ts, holds.released[row.id])) continue;
    if (isNewer(row.ts, held[row.id])) held[row.id] = row.ts;
  }
  return { held, released: { ...holds.released } };
}

/** `holds` with `id` released, or null when `id` is not held. */
export function releaseHold(holds: SyncHolds, id: string): SyncHolds | null {
  const ts = holds.held[id];
  if (ts === undefined) return null;
  const held = { ...holds.held };
  delete held[id];
  return { held, released: { ...holds.released, [id]: ts } };
}

export function heldIds(holds: SyncHolds): ReadonlySet<string> {
  return new Set(Object.keys(holds.held));
}
