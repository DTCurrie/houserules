// Managed regions: a marker-delimited block the kit owns inside a file the USER owns
// (their CLAUDE.md, .gitignore, .prettierignore).
//
// The one invariant everything here exists to protect: bytes outside the markers are
// never touched. `upsertRegion` splices by index rather than reformatting, so the
// prefix and suffix come through verbatim — `test/regions.test.ts` (RG2) asserts that
// byte-for-byte rather than by substring.
//
// Pure by construction: no filesystem access, so the same call decides the dry-run
// preview and the real write.

export interface RegionSpec {
  id: string;
  start: string;
  end: string;
  anchor: 'eof' | 'after-h1';
  pad?: boolean;
}

export type UpsertStatus = 'created' | 'replaced' | 'inserted';

interface Located {
  blockStart: number;
  blockEnd: number;
  innerStart: number;
  innerEnd: number;
}

function locate(content: string, spec: RegionSpec): Located | null {
  const start = content.indexOf(spec.start);
  if (start === -1) return null;
  const innerStart = start + spec.start.length;
  const innerEnd = content.indexOf(spec.end, innerStart);
  if (innerEnd === -1) return null;
  return {
    blockStart: start,
    blockEnd: innerEnd + spec.end.length,
    innerStart,
    innerEnd,
  };
}

function buildBlock(body: string, spec: RegionSpec): string {
  const sep = spec.pad ? '\n\n' : '\n';
  return `${spec.start}${sep}${body.trimEnd()}${sep}${spec.end}`;
}

export function extractBody(content: string, spec: RegionSpec): string | null {
  const found = locate(content, spec);
  if (!found) return null;
  return content
    .slice(found.innerStart, found.innerEnd)
    .replace(/^\n/, '')
    .replace(/\n$/, '');
}

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
