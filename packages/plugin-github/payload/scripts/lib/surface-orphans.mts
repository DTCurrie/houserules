/**
 * Detects surface-orphaned ledger entries: present in a rendered `.md` surface but in
 * neither the push queue nor the pulled board index. That state is invisible to `backfill`
 * (which reconciles board to queue) and to `pull` (which re-renders only when the index
 * changed), and it is how five entries silently wedged every ledger write at the
 * code-health close.
 *
 * Pure. The caller reads the surfaces, the queue, and the index, and passes their contents
 * in, so this lib never reaches for the filesystem or config.
 */

/** One entry as a rendered surface holds it. */
export interface SurfaceEntry {
  /** The ledger id inside the heading brackets, e.g. `HOUSERULES-d32c08`. */
  id: string;
  /** The heading text after the bracketed id. */
  title: string;
  /**
   * The raw section text below the heading, up to the next entry heading or end of file.
   * Kept verbatim so a reconcile can re-enqueue the entry without inventing content.
   */
  body: string;
  /** The surface file the entry was parsed from, as the caller named it. */
  surface: string;
}

/**
 * Parses the entries out of one rendered surface. An entry starts at a `## [<id>] <title>`
 * heading. Content above the first entry heading belongs to no entry and is ignored.
 */
export function surfaceEntries(
  surface: string,
  content: string,
): SurfaceEntry[] {
  const headingPattern = /^## \[([^\]]+)\] (.+)$/;
  const lines = content.split('\n');
  const entries: SurfaceEntry[] = [];
  let current: { id: string; title: string; bodyLines: string[] } | null = null;

  for (const line of lines) {
    const match = headingPattern.exec(line);
    if (match) {
      if (current) {
        entries.push({
          id: current.id,
          title: current.title,
          body: current.bodyLines.join('\n'),
          surface,
        });
      }
      current = {
        id: match[1] as string,
        title: match[2] as string,
        bodyLines: [],
      };
      continue;
    }

    if (current) {
      current.bodyLines.push(line);
    }
  }

  if (current) {
    entries.push({
      id: current.id,
      title: current.title,
      body: current.bodyLines.join('\n'),
      surface,
    });
  }

  return entries;
}

/**
 * The entries present in a surface but in neither the queue nor the index. Ids are
 * compared exactly. An entry in either set is reachable by sync and is not an orphan.
 */
export function findSurfaceOrphans(
  entries: readonly SurfaceEntry[],
  queueIds: ReadonlySet<string>,
  indexIds: ReadonlySet<string>,
): SurfaceEntry[] {
  return entries.filter(
    (entry) => !queueIds.has(entry.id) && !indexIds.has(entry.id),
  );
}
