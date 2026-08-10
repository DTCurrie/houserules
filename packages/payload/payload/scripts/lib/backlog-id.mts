import { createHash } from 'node:crypto';

/**
 * A backlog entry ID: `<PREFIX>-<6 hex>`, where PREFIX is one or more uppercase ASCII
 * characters. The single source of truth for the shape, shared by backlog-log.mjs, which
 * mints IDs, and package-changelog.mjs, which scrapes them out of commit messages. Change
 * the shape here and both follow.
 */
export const BACKLOG_ID = /\b[A-Z][A-Z0-9]*-[0-9a-f]{6}\b/g;
export const ENTRY_HEAD = /^## \[([A-Z][A-Z0-9]*-[0-9a-f]{6})\] (.+)$/;

/**
 * Content-hashed, so the same prefix and title at a given instant are stable while a
 * re-add gets a fresh ID through the timestamp.
 */
export function makeId(prefix: string, title: string, iso: string): string {
  const h = createHash('sha256')
    .update(`${prefix}|${title}|${iso}`)
    .digest('hex')
    .slice(0, 6);
  return `${prefix}-${h}`;
}
