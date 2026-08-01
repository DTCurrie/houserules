// The backlog entry ID format, shared by backlog-log.mjs (which mints IDs and parses
// entry headings) and package-changelog.mjs (which scrapes IDs out of commit messages
// to cross-link a commit to the backlog items it resolved). Single source of truth so
// the two never drift apart — if you change the ID shape, both update together.
import { createHash } from 'node:crypto';

// <PREFIX>-<6 hex>. PREFIX is uppercase ASCII, 1+ chars (SIM, DATA, UI, ...).
export const BACKLOG_ID = /\b[A-Z][A-Z0-9]*-[0-9a-f]{6}\b/g;
export const ENTRY_HEAD = /^## \[([A-Z][A-Z0-9]*-[0-9a-f]{6})\] (.+)$/;

// Content-hashed: the same (prefix, title) at a given instant is stable, but re-adds
// get a fresh id via the timestamp.
export function makeId(prefix: string, title: string, iso: string): string {
  const h = createHash('sha256')
    .update(`${prefix}|${title}|${iso}`)
    .digest('hex')
    .slice(0, 6);
  return `${prefix}-${h}`;
}
