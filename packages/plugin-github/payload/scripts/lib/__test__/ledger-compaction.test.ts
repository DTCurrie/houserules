import { describe, expect, it } from 'vitest';

import {
  compactBacklog,
  compactDecisions,
  compactionIsNoop,
  describeCompaction,
  pendingEntryIds,
  serializeLedger,
} from '../ledger-compaction.mjs';
import { buildPushQueue } from '../push-queue.mjs';
import type { LedgerRecord } from '../push-queue.mjs';

function backlogAdd(
  id: string,
  overrides: Partial<LedgerRecord> = {},
): LedgerRecord {
  return {
    ts: '2026-01-01T00:00:00Z',
    id,
    action: 'add',
    file: 'BACKLOG.md',
    title: 'Fix the thing',
    content: 'original body',
    chat: null,
    ...overrides,
  };
}

function decide(
  id: string,
  overrides: Partial<LedgerRecord> = {},
): LedgerRecord {
  return {
    ts: '2026-02-03T00:00:00Z',
    id,
    action: 'decide',
    file: 'DECISIONS.md',
    title: 'Use the thing',
    content: 'because',
    scope: ['src/'],
    chat: null,
    ...overrides,
  };
}

function syncedIssue(id: string, issue: number): LedgerRecord {
  return {
    ts: '2026-01-02T00:00:00Z',
    id,
    action: 'synced',
    op: 'create-issue',
    issue,
  };
}

function syncedDraft(id: string, itemId: string): LedgerRecord {
  return {
    ts: '2026-02-04T00:00:00Z',
    id,
    action: 'synced',
    op: 'create-draft',
    itemId,
  };
}

function compactBoth(backlog: LedgerRecord[], decisions: LedgerRecord[]) {
  const pending = pendingEntryIds(buildPushQueue(backlog, decisions));
  return {
    backlog: compactBacklog(backlog, pending),
    decisions: compactDecisions(decisions, pending),
  };
}

function queueSurvivesCompaction(
  backlog: LedgerRecord[],
  decisions: LedgerRecord[],
): boolean {
  const compacted = compactBoth(backlog, decisions);
  return (
    JSON.stringify(
      buildPushQueue(compacted.backlog.records, compacted.decisions.records),
    ) === JSON.stringify(buildPushQueue(backlog, decisions))
  );
}

describe('compactBacklog', () => {
  it('drops an entry removed before it ever reached the board', () => {
    const records = [
      backlogAdd('A'),
      { ts: '2026-01-03T00:00:00Z', id: 'A', action: 'remove', reason: 'moot' },
    ];

    const result = compactBacklog(records, new Set());

    expect(result.dropped).toEqual(['A']);
    expect(result.records).toEqual([]);
  });

  it('drops an entry whose close already reached the board', () => {
    const records = [
      backlogAdd('A'),
      syncedIssue('A', 7),
      { ts: '2026-01-03T00:00:00Z', id: 'A', action: 'remove', reason: 'done' },
      {
        ts: '2026-01-04T00:00:00Z',
        id: 'A',
        action: 'synced',
        op: 'close-issue',
      },
    ];

    const result = compactBacklog(records, new Set());

    expect(result.dropped).toEqual(['A']);
    expect(result.records).toEqual([]);
  });

  it('keeps every record of an entry a push still owes something', () => {
    const records = [backlogAdd('A'), syncedIssue('A', 7)];

    const result = compactBacklog(records, new Set(['A']));

    expect(result.kept).toEqual(['A']);
    expect(result.records).toEqual(records);
  });

  it('folds a synced entry to one record carrying its issue number', () => {
    const records = [backlogAdd('A'), syncedIssue('A', 7)];

    const result = compactBacklog(records, new Set());

    expect(result.folded).toEqual(['A']);
    expect(result.records).toEqual([
      { ...backlogAdd('A'), checkpoint: { issue: 7 } },
    ]);
  });

  it('folds the latest title and body into the surviving record', () => {
    const records = [
      backlogAdd('A'),
      syncedIssue('A', 7),
      {
        ts: '2026-01-05T00:00:00Z',
        id: 'A',
        action: 'update',
        title: 'Fix it properly',
        content: 'revised body',
      },
      { ...syncedIssue('A', 7), op: 'update-issue' },
    ];

    const [record] = compactBacklog(records, new Set()).records;

    expect(record.title).toBe('Fix it properly');
    expect(record.content).toBe('revised body');
  });

  it('folds the surface an entry was moved to, not the one it was filed under', () => {
    const records = [
      backlogAdd('A', { file: 'core.BACKLOG.md' }),
      syncedIssue('A', 7),
      {
        ts: '2026-01-06T00:00:00Z',
        id: 'A',
        action: 'move',
        file: 'cli.BACKLOG.md',
      },
      { ...syncedIssue('A', 7), op: 'report-move' },
    ];

    const [record] = compactBacklog(records, new Set()).records;

    expect(record.file).toBe('cli.BACKLOG.md');
  });

  it('preserves the order surviving entries were filed in', () => {
    const records = [
      backlogAdd('A'),
      syncedIssue('A', 1),
      backlogAdd('B'),
      { ts: '2026-01-03T00:00:00Z', id: 'B', action: 'remove', reason: 'moot' },
      backlogAdd('C'),
      syncedIssue('C', 3),
    ];

    const result = compactBacklog(records, new Set());

    expect(result.records.map((record) => record.id)).toEqual(['A', 'C']);
  });
});

describe('compactDecisions', () => {
  it('folds a synced decision to one record carrying its item id', () => {
    const records = [decide('D'), syncedDraft('D', 'item-1')];

    const result = compactDecisions(records, new Set());

    expect(result.records).toEqual([
      { ...decide('D'), checkpoint: { itemId: 'item-1' } },
    ]);
  });

  it('records that a supersede flip already landed, so it is not re-emitted', () => {
    const records = [
      decide('D'),
      syncedDraft('D', 'item-1'),
      {
        ts: '2026-02-05T00:00:00Z',
        id: 'D',
        action: 'synced',
        op: 'mark-superseded',
      },
    ];

    const [record] = compactDecisions(records, new Set()).records;

    expect(record.checkpoint).toEqual({
      itemId: 'item-1',
      markedSuperseded: true,
    });
  });

  it('never drops a decision, because a later supersede resolves targets by id', () => {
    const records = [decide('D'), syncedDraft('D', 'item-1')];

    const result = compactDecisions(records, new Set());

    expect(result.dropped).toEqual([]);
  });

  it('preserves fields the push fold has no type for', () => {
    const records: LedgerRecord[] = [
      { ...decide('D'), under: 'PARENT-1' } as LedgerRecord,
      syncedDraft('D', 'item-1'),
    ];

    const [record] = compactDecisions(records, new Set()).records;

    expect((record as unknown as Record<string, unknown>).under).toBe(
      'PARENT-1',
    );
  });

  it('keeps the birth timestamp, which is what the decided date is read from', () => {
    const records = [decide('D'), syncedDraft('D', 'item-1')];

    const [record] = compactDecisions(records, new Set()).records;

    expect(record.ts).toBe('2026-02-03T00:00:00Z');
  });
});

describe('the push queue built from compacted records', () => {
  it('is unchanged when every entry is already synced', () => {
    const backlog = [backlogAdd('A'), syncedIssue('A', 7)];
    const decisions = [decide('D'), syncedDraft('D', 'item-1')];

    expect(queueSurvivesCompaction(backlog, decisions)).toBe(true);
  });

  it('is unchanged when an entry has never been pushed', () => {
    const backlog = [backlogAdd('A')];

    expect(queueSurvivesCompaction(backlog, [])).toBe(true);
  });

  it('is unchanged when a synced entry was edited after its push', () => {
    const backlog = [
      backlogAdd('A'),
      syncedIssue('A', 7),
      {
        ts: '2026-01-05T00:00:00Z',
        id: 'A',
        action: 'update',
        content: 'revised',
      },
    ];

    expect(queueSurvivesCompaction(backlog, [])).toBe(true);
  });

  it('is unchanged when a synced entry is awaiting its close', () => {
    const backlog = [
      backlogAdd('A'),
      syncedIssue('A', 7),
      { ts: '2026-01-06T00:00:00Z', id: 'A', action: 'remove', reason: 'done' },
    ];

    expect(queueSurvivesCompaction(backlog, [])).toBe(true);
  });

  it('is unchanged when one decision supersedes another that already synced', () => {
    const decisions = [
      decide('D'),
      syncedDraft('D', 'item-1'),
      decide('E', { action: 'supersede', supersedes: ['D'] }),
    ];

    expect(queueSurvivesCompaction([], decisions)).toBe(true);
  });

  it('is unchanged when a supersede and its flip have both landed', () => {
    const decisions = [
      decide('D'),
      syncedDraft('D', 'item-1'),
      {
        ts: '2026-02-05T00:00:00Z',
        id: 'D',
        action: 'synced',
        op: 'mark-superseded',
      },
      decide('E', { action: 'supersede', supersedes: ['D'] }),
      syncedDraft('E', 'item-2'),
    ];

    expect(queueSurvivesCompaction([], decisions)).toBe(true);
  });

  it('does not resurrect an adopted issue as a second attach', () => {
    const backlog = [
      backlogAdd('A', { issue: 42 }),
      { ...syncedIssue('A', 42), op: 'attach-issue' },
    ];

    expect(queueSurvivesCompaction(backlog, [])).toBe(true);
    expect(
      buildPushQueue(compactBacklog(backlog, new Set()).records, []),
    ).toEqual([]);
  });
});

describe('compacting an already compacted ledger', () => {
  it('changes nothing', () => {
    const backlog = [backlogAdd('A'), syncedIssue('A', 7)];
    const once = compactBacklog(backlog, new Set()).records;
    const twice = compactBacklog(once, new Set());

    expect(compactionIsNoop(once, twice)).toBe(true);
  });

  it('reports a fully compacted ledger as unchanged rather than as work', () => {
    const decisions = [decide('D'), syncedDraft('D', 'item-1')];
    const once = compactDecisions(decisions, new Set()).records;

    expect(compactionIsNoop(once, compactDecisions(once, new Set()))).toBe(
      true,
    );
  });
});

describe('serializeLedger', () => {
  it('writes one newline-terminated JSON object per record', () => {
    const text = serializeLedger([backlogAdd('A')]);

    expect(text.endsWith('\n')).toBe(true);
    expect(text.trimEnd().split('\n')).toHaveLength(1);
    expect(JSON.parse(text.trimEnd())).toEqual(backlogAdd('A'));
  });

  it('round-trips a body that is still gzipped and base64 encoded', () => {
    const encoded = 'H4sIAAAAAAAAA0tMSlZILC4uzc0BAKgSWJENAAAA';
    const text = serializeLedger([backlogAdd('A', { content: encoded })]);

    expect(JSON.parse(text.trimEnd()).content).toBe(encoded);
  });
});

describe('describeCompaction', () => {
  it('names the counts for each of the three outcomes', () => {
    const result = {
      records: [backlogAdd('A')],
      dropped: ['B', 'C'],
      folded: ['A'],
      kept: [],
    };

    expect(describeCompaction('backlog', 9, result)).toBe(
      'backlog: 9 records -> 1 (2 finished entries dropped, 1 folded, 0 pending kept)',
    );
  });
});
