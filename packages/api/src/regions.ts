/** The markers and placement of one managed block inside a file the user owns. */
export interface RegionSpec {
  id: string;
  start: string;
  end: string;
  anchor: 'eof' | 'after-h1';
  pad?: boolean;
  /**
   * A marker pair an earlier houserules version wrote, recognized on read so its block is adopted.
   *
   * Read-side only. Every write emits `start`/`end`, so an install converges on the current
   * markers in one update and never carries both. Without this an install whose markers were
   * renamed matches nothing, and `upsertRegion` inserts a SECOND block while the original is
   * orphaned in place, still claiming to be houserules-maintained.
   */
  legacy?: { start: string; end: string };
}

type UpsertStatus = 'created' | 'replaced' | 'inserted';

interface Located {
  blockStart: number;
  blockEnd: number;
  innerStart: number;
  innerEnd: number;
}

function locateMarkers(
  content: string,
  startMarker: string,
  endMarker: string,
): Located | null {
  const start = content.indexOf(startMarker);
  if (start === -1) return null;
  const innerStart = start + startMarker.length;
  const innerEnd = content.indexOf(endMarker, innerStart);
  if (innerEnd === -1) return null;
  return {
    blockStart: start,
    blockEnd: innerEnd + endMarker.length,
    innerStart,
    innerEnd,
  };
}

// Current markers win, so a file that somehow carries both converges rather than ping-ponging.
function locate(content: string, spec: RegionSpec): Located | null {
  const current = locateMarkers(content, spec.start, spec.end);
  if (current || !spec.legacy) return current;
  return locateMarkers(content, spec.legacy.start, spec.legacy.end);
}

function buildBlock(body: string, spec: RegionSpec): string {
  const sep = spec.pad ? '\n\n' : '\n';
  return `${spec.start}${sep}${body.trimEnd()}${sep}${spec.end}`;
}

/**
 * Whether the block on disk sits under the legacy markers rather than the current pair.
 *
 * Callers use this to decide that a recorded hash is not comparable. A manifest written by the
 * houserules generation that used those markers computed its region hash with that generation's
 * semantics, so measuring today's body against it reports drift that says nothing about whether
 * the user edited anything. The block is houserules-owned either way, and bytes outside the markers are
 * never touched, so adopting it is the migration working rather than an edit being lost.
 */
export function hasLegacyRegion(content: string, spec: RegionSpec): boolean {
  if (!spec.legacy) return false;
  if (locateMarkers(content, spec.start, spec.end)) return false;
  return locateMarkers(content, spec.legacy.start, spec.legacy.end) !== null;
}

/** The managed content between the markers, or null when the markers are absent. */
export function extractBody(content: string, spec: RegionSpec): string | null {
  const found = locate(content, spec);
  if (!found) return null;
  return content
    .slice(found.innerStart, found.innerEnd)
    .replace(/^\n/, '')
    .replace(/\n$/, '');
}

/**
 * Splices `body` into the marker block inside a file the user owns. Bytes outside the
 * markers are never touched, which is the invariant the whole managed-region feature
 * rests on. The splice is by index rather than a reformat, so the prefix and suffix come
 * through verbatim. `src/core/__tests__/regions.test.ts` (RG2) asserts that byte for byte.
 *
 * Pure by construction, with no filesystem access, so the same call decides the dry-run
 * preview and the real write.
 *
 * @returns The new content, and whether the block was created, replaced, or inserted.
 */
export function upsertRegion(
  content: string | null,
  body: string,
  spec: RegionSpec,
): { content: string; status: UpsertStatus } {
  const block = buildBlock(body, spec);

  if (content === null || content === '') {
    return { content: `${block}\n`, status: 'created' };
  }

  const found = locate(content, spec);
  if (found) {
    return {
      content:
        content.slice(0, found.blockStart) +
        block +
        content.slice(found.blockEnd),
      status: 'replaced',
    };
  }

  if (spec.anchor === 'after-h1') {
    const lines = content.split('\n');
    const h1 = lines.findIndex((line) => /^#\s/.test(line));
    if (h1 !== -1) {
      lines.splice(h1 + 1, 0, '', block);
      return { content: lines.join('\n'), status: 'inserted' };
    }
  }

  const base = content.endsWith('\n') ? content : `${content}\n`;
  return { content: `${base}\n${block}\n`, status: 'inserted' };
}
