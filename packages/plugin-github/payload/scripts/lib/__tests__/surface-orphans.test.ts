import { describe, expect, it } from 'vitest';

import { findSurfaceOrphans, surfaceEntries } from '../surface-orphans.mjs';
import type { SurfaceEntry } from '../surface-orphans.mjs';

describe('surfaceEntries', () => {
  it('parses multiple entries in order with id, title, verbatim body, and surface name', () => {
    const content = `# Backlog

## [HOUSERULES-d32c08] First entry title

**Logged:** 2026-08-21

Body line one.
Body line two.

---

## [API-349627] Second entry title

Second body.
`;

    expect(surfaceEntries('BACKLOG.md', content)).toEqual([
      {
        id: 'HOUSERULES-d32c08',
        title: 'First entry title',
        body: '\n**Logged:** 2026-08-21\n\nBody line one.\nBody line two.\n\n---\n',
        surface: 'BACKLOG.md',
      },
      {
        id: 'API-349627',
        title: 'Second entry title',
        body: '\nSecond body.\n',
        surface: 'BACKLOG.md',
      },
    ]);
  });

  it('ignores preamble content above the first entry heading', () => {
    const content = `# Backlog

Deferred work. Add entries via the tool.

## [PLUGINGITHUB-abc123] Only entry

Its body.
`;

    const entries = surfaceEntries('BACKLOG.md', content);

    expect(entries).toHaveLength(1);
    expect(entries[0]?.id).toBe('PLUGINGITHUB-abc123');
  });

  it('keeps a body line starting with ## that has no bracketed id inside the body', () => {
    const content = `## [HOUSERULES-1a2b3c] Entry with a fake heading in its body

Some text.

## Not a real entry heading, no brackets

More text.
`;

    const entries = surfaceEntries('BACKLOG.md', content);

    expect(entries).toHaveLength(1);
    expect(entries[0]?.body).toBe(
      '\nSome text.\n\n## Not a real entry heading, no brackets\n\nMore text.\n',
    );
  });

  it('keeps --- separator lines inside the body', () => {
    const content = `## [HOUSERULES-5f6e7d] Entry title

Text above.

---

Text below.
`;

    const entries = surfaceEntries('BACKLOG.md', content);

    expect(entries[0]?.body).toBe('\nText above.\n\n---\n\nText below.\n');
  });

  it('produces an empty body for an entry at end of file with no following lines', () => {
    const content = `## [HOUSERULES-000abc] Trailing entry`;

    const entries = surfaceEntries('BACKLOG.md', content);

    expect(entries).toEqual([
      {
        id: 'HOUSERULES-000abc',
        title: 'Trailing entry',
        body: '',
        surface: 'BACKLOG.md',
      },
    ]);
  });

  it('parses a title containing a bracket', () => {
    const content = `## [DECISIONS-99] Prefer [square] over round brackets

Body.
`;

    const entries = surfaceEntries('DECISIONS.md', content);

    expect(entries[0]?.title).toBe('Prefer [square] over round brackets');
  });
});

describe('findSurfaceOrphans', () => {
  function entry(id: string): SurfaceEntry {
    return { id, title: 'Title', body: 'Body.', surface: 'BACKLOG.md' };
  }

  it('excludes an entry whose id is in the queue only', () => {
    const entries = [entry('HOUSERULES-aaa111')];

    expect(
      findSurfaceOrphans(entries, new Set(['HOUSERULES-aaa111']), new Set()),
    ).toEqual([]);
  });

  it('excludes an entry whose id is in the index only', () => {
    const entries = [entry('HOUSERULES-bbb222')];

    expect(
      findSurfaceOrphans(entries, new Set(), new Set(['HOUSERULES-bbb222'])),
    ).toEqual([]);
  });

  it('excludes an entry whose id is in both the queue and the index', () => {
    const entries = [entry('HOUSERULES-ccc333')];

    expect(
      findSurfaceOrphans(
        entries,
        new Set(['HOUSERULES-ccc333']),
        new Set(['HOUSERULES-ccc333']),
      ),
    ).toEqual([]);
  });

  it('includes an entry whose id is in neither the queue nor the index', () => {
    const entries = [entry('HOUSERULES-ddd444')];

    expect(findSurfaceOrphans(entries, new Set(), new Set())).toEqual(entries);
  });

  it('preserves input order across a mix of orphaned and reachable entries', () => {
    const orphanA = entry('HOUSERULES-111aaa');
    const reachable = entry('HOUSERULES-222bbb');
    const orphanB = entry('HOUSERULES-333ccc');

    const result = findSurfaceOrphans(
      [orphanA, reachable, orphanB],
      new Set(['HOUSERULES-222bbb']),
      new Set(),
    );

    expect(result).toEqual([orphanA, orphanB]);
  });

  it('returns an empty result for an empty entries list', () => {
    expect(findSurfaceOrphans([], new Set(['anything']), new Set())).toEqual(
      [],
    );
  });
});
