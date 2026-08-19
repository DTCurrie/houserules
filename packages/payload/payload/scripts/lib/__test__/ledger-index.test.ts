import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  emptyIndex,
  findEntry,
  indexBasename,
  loadIndex,
  mergeWithQueue,
  parseIndex,
  serializeIndex,
} from '../ledger-index.mjs';
import type { LedgerEntry, LedgerIndex } from '../ledger-index.mjs';

function ledgerEntry(overrides: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    id: 'BACKLOG-abc123',
    itemId: 'item-1',
    issue: 42,
    title: 'Fix the thing',
    body: 'The report body.',
    surface: 'plugin-github',
    date: '2026-08-03',
    chat: null,
    status: 'Todo',
    scope: [],
    under: null,
    supersedes: [],
    supersededBy: null,
    ...overrides,
  };
}

function filledIndex(entries: LedgerEntry[] = [ledgerEntry()]): LedgerIndex {
  return {
    ...emptyIndex('backlog', '2026-08-03T00:00:00.000Z'),
    projects: [7],
    entries,
  };
}

describe('serializeIndex and parseIndex', () => {
  it('round trips an index through serialization', () => {
    const index = filledIndex();

    const parsed = parseIndex(serializeIndex(index), 'backlog');

    expect(parsed).toEqual(index);
  });

  it('serializes with a trailing newline', () => {
    expect(
      serializeIndex(
        emptyIndex('backlog', '2026-08-03T00:00:00.000Z'),
      ).endsWith('\n'),
    ).toBe(true);
  });
});

describe('parseIndex', () => {
  it('returns null for an empty string', () => {
    expect(parseIndex('', 'backlog')).toBeNull();
  });

  it('returns null for truncated JSON', () => {
    expect(parseIndex('{', 'backlog')).toBeNull();
  });

  it('returns null when the parsed value is not an object', () => {
    expect(parseIndex('"just a string"', 'backlog')).toBeNull();
  });

  it('returns null when the version does not match INDEX_VERSION', () => {
    const raw = serializeIndex({ ...filledIndex(), version: 999 });

    expect(parseIndex(raw, 'backlog')).toBeNull();
  });

  it('returns null when the kind does not match the requested kind', () => {
    const raw = serializeIndex(filledIndex());

    expect(parseIndex(raw, 'decisions')).toBeNull();
  });

  it('returns null when entries is not an array', () => {
    const raw = JSON.stringify({ ...filledIndex(), entries: 'nope' });

    expect(parseIndex(raw, 'backlog')).toBeNull();
  });
});

describe('findEntry', () => {
  it('returns the matching entry', () => {
    const entry = ledgerEntry({ id: 'BACKLOG-target' });
    const index = filledIndex([ledgerEntry({ id: 'BACKLOG-other' }), entry]);

    expect(findEntry(index, 'BACKLOG-target')).toEqual(entry);
  });

  it('returns null when no entry matches', () => {
    const index = filledIndex([ledgerEntry({ id: 'BACKLOG-other' })]);

    expect(findEntry(index, 'BACKLOG-missing')).toBeNull();
  });

  it('returns null for a null index', () => {
    expect(findEntry(null, 'BACKLOG-missing')).toBeNull();
  });
});

describe('loadIndex', () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('returns null when the index file does not exist', () => {
    dir = mkdtempSync(join(tmpdir(), 'ledger-index-'));

    expect(loadIndex(dir, 'backlog')).toBeNull();
  });

  it('returns the parsed index for a valid file', () => {
    dir = mkdtempSync(join(tmpdir(), 'ledger-index-'));
    const index = filledIndex();
    writeFileSync(join(dir, indexBasename('backlog')), serializeIndex(index));

    expect(loadIndex(dir, 'backlog')).toEqual(index);
  });

  it('returns null when the index path is a directory rather than a file', () => {
    dir = mkdtempSync(join(tmpdir(), 'ledger-index-'));
    mkdirSync(join(dir, indexBasename('backlog')));

    expect(loadIndex(dir, 'backlog')).toBeNull();
  });
});

describe('mergeWithQueue', () => {
  it('returns a copy of the queue for a null index', () => {
    const queued = [ledgerEntry({ id: 'BACKLOG-a' })];

    expect(mergeWithQueue(null, queued)).toEqual(queued);
  });

  it('replaces a matching index entry with the queued entry in place', () => {
    const indexA = ledgerEntry({ id: 'BACKLOG-a', title: 'From board' });
    const indexB = ledgerEntry({ id: 'BACKLOG-b', title: 'Untouched' });
    const index = filledIndex([indexA, indexB]);
    const queuedA = ledgerEntry({ id: 'BACKLOG-a', title: 'From queue' });

    expect(mergeWithQueue(index, [queuedA])).toEqual([queuedA, indexB]);
  });

  it('appends a queued entry with an id the index does not hold', () => {
    const indexA = ledgerEntry({ id: 'BACKLOG-a' });
    const index = filledIndex([indexA]);
    const queuedNew = ledgerEntry({ id: 'BACKLOG-new' });

    expect(mergeWithQueue(index, [queuedNew])).toEqual([indexA, queuedNew]);
  });

  it('prefers the queued body over the index body for the same id', () => {
    const index = filledIndex([
      ledgerEntry({ id: 'BACKLOG-a', body: 'Stale body from the board.' }),
    ]);
    const queuedA = ledgerEntry({
      id: 'BACKLOG-a',
      body: 'Fresh body from the queue.',
    });

    const [merged] = mergeWithQueue(index, [queuedA]);

    expect(merged?.body).toBe('Fresh body from the queue.');
  });
});
