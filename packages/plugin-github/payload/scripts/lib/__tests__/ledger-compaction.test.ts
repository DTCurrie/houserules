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

function removed(id: string, reason: string): LedgerRecord {
  return { ts: '2026-01-03T00:00:00Z', id, action: 'remove', reason };
}

function updatedTitle(id: string, title: string): LedgerRecord {
  return { ts: '2026-01-05T00:00:00Z', id, action: 'update', title };
}

function amended(id: string, content: string): LedgerRecord {
  return { ts: '2026-02-05T00:00:00Z', id, action: 'amend', content };
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

function onBoard(ids: string[]) {
  return ids.map((id) => ({
    id,
    itemId: 'item-' + id,
    issue: 7,
    title: 'On the board',
    body: 'body',
    surface: 'BACKLOG.md',
    date: '2026-01-01',
    chat: null,
    status: 'Todo',
    scope: [],
    under: null,
    supersedes: [],
    supersededBy: null,
  }));
}

function queueSurvivesCompaction(
  backlog: LedgerRecord[],
  decisions: LedgerRecord[],
  backlogIndex = onBoard([]),
  decisionsIndex = onBoard([]),
): boolean {
  const pending = pendingEntryIds(
    buildPushQueue(backlog, decisions, backlogIndex, decisionsIndex),
  );
  const b = compactBacklog(backlog, pending, backlogIndex);
  const d = compactDecisions(decisions, pending, decisionsIndex);
  return (
    JSON.stringify(
      buildPushQueue(b.records, d.records, backlogIndex, decisionsIndex),
    ) ===
    JSON.stringify(
      buildPushQueue(backlog, decisions, backlogIndex, decisionsIndex),
    )
  );
}

describe('compactBacklog', () => {
  it('drops an entry removed before it ever reached the board', () => {
    const records = [backlogAdd('A'), removed('A', 'moot')];

    const result = compactBacklog(records, new Set(), onBoard([]));

    expect(result.dropped).toEqual([{ id: 'A', title: 'Fix the thing' }]);
    expect(result.records).toEqual([]);
  });

  it('keeps an unsynced entry the index has not confirmed, since it is still owed a push', () => {
    const result = compactBacklog([backlogAdd('A')], new Set(), onBoard([]));

    expect(result.kept).toEqual(['A']);
    expect(result.dropped).toEqual([]);
  });

  it('keeps an entry the caller calls pending, even when it looks removed before sync', () => {
    const records = [backlogAdd('A'), removed('A', 'moot')];

    const result = compactBacklog(records, new Set(['A']), onBoard([]));

    expect(result.kept).toEqual(['A']);
    expect(result.records).toEqual(records);
  });

  it('keeps the records of an on-board entry whose add record an earlier compaction dropped', () => {
    const records = [updatedTitle('A', 'Fix it properly')];

    const result = compactBacklog(records, new Set(['A']), onBoard(['A']));

    expect(result.kept).toEqual(['A']);
    expect(result.records).toEqual(records);
  });

  it('leaves a board entry that contributed no records out of both manifests', () => {
    const records = [backlogAdd('A'), syncedIssue('A', 7)];

    const result = compactBacklog(records, new Set(), onBoard(['A', 'B']));

    expect(result.dropped).toEqual([{ id: 'A', title: 'Fix the thing' }]);
    expect(result.kept).toEqual([]);
  });

  it('drops an entry the index confirms is on the board', () => {
    const records = [backlogAdd('A'), syncedIssue('A', 7)];

    const result = compactBacklog(records, new Set(), onBoard(['A']));

    expect(result.dropped).toEqual([{ id: 'A', title: 'Fix the thing' }]);
    expect(result.records).toEqual([]);
  });

  it('keeps every record of an entry a push still owes something', () => {
    const records = [backlogAdd('A'), syncedIssue('A', 7)];

    const result = compactBacklog(records, new Set(['A']), onBoard(['A']));

    expect(result.kept).toEqual(['A']);
    expect(result.records).toEqual(records);
  });

  it('drops the title the entry last carried, not the one it was filed with', () => {
    const records = [
      backlogAdd('A'),
      syncedIssue('A', 7),
      {
        ts: '2026-01-05T00:00:00Z',
        id: 'A',
        action: 'update',
        title: 'Fix it properly',
      },
      { ...syncedIssue('A', 7), op: 'update-issue' },
    ];

    expect(compactBacklog(records, new Set(), onBoard(['A'])).dropped).toEqual([
      { id: 'A', title: 'Fix it properly' },
    ]);
  });

  it('empties the ledger entirely when the board confirms every entry', () => {
    const records = [
      backlogAdd('A'),
      syncedIssue('A', 1),
      backlogAdd('B'),
      syncedIssue('B', 2),
    ];

    expect(
      compactBacklog(records, new Set(), onBoard(['A', 'B'])).records,
    ).toEqual([]);
  });
});

describe('compactDecisions', () => {
  it('drops a decision the index confirms', () => {
    const records = [decide('D'), syncedDraft('D', 'item-1')];

    const result = compactDecisions(records, new Set(), onBoard(['D']));

    expect(result.records).toEqual([]);
    expect(result.dropped).toEqual([{ id: 'D', title: 'Use the thing' }]);
  });

  it('keeps one the index has not confirmed, even with a synced record present', () => {
    const records = [decide('D'), syncedDraft('D', 'item-1')];

    const result = compactDecisions(records, new Set(), onBoard([]));

    expect(result.kept).toEqual(['D']);
    expect(result.records).toEqual(records);
  });

  it('keeps the records of an on-board decision whose birth record an earlier compaction dropped', () => {
    const records = [amended('D', 'revised')];

    const result = compactDecisions(records, new Set(['D']), onBoard(['D']));

    expect(result.kept).toEqual(['D']);
    expect(result.records).toEqual(records);
  });
});

describe('the push queue built from compacted records', () => {
  it('is unchanged when every entry is on the board', () => {
    const backlog = [backlogAdd('A'), syncedIssue('A', 7)];
    const decisions = [decide('D'), syncedDraft('D', 'item-1')];

    expect(
      queueSurvivesCompaction(
        backlog,
        decisions,
        onBoard(['A']),
        onBoard(['D']),
      ),
    ).toBe(true);
  });

  it('is unchanged when an entry has never been pushed', () => {
    expect(queueSurvivesCompaction([backlogAdd('A')], [])).toBe(true);
  });

  it('is unchanged when a synced entry is awaiting its close', () => {
    const backlog = [
      backlogAdd('A'),
      syncedIssue('A', 7),
      { ts: '2026-01-06T00:00:00Z', id: 'A', action: 'remove', reason: 'done' },
    ];

    expect(queueSurvivesCompaction(backlog, [], onBoard(['A']), [])).toBe(true);
  });

  it('is unchanged when an entry was removed before it ever synced', () => {
    const backlog = [backlogAdd('A'), removed('A', 'moot')];

    expect(queueSurvivesCompaction(backlog, [])).toBe(true);
  });

  it('is unchanged when an on-board entry has an unpushed edit and no add record left', () => {
    const backlog = [updatedTitle('A', 'Fix it properly')];

    expect(queueSurvivesCompaction(backlog, [], onBoard(['A']), [])).toBe(true);
  });
});

describe('compacting an already compacted ledger', () => {
  it('changes nothing', () => {
    const backlog = [backlogAdd('A'), syncedIssue('A', 7)];
    const once = compactBacklog(backlog, new Set(), onBoard(['A'])).records;

    expect(
      compactionIsNoop(once, compactBacklog(once, new Set(), onBoard(['A']))),
    ).toBe(true);
  });
});

describe('serializeLedger', () => {
  it('writes one newline-terminated JSON object per record', () => {
    const text = serializeLedger([backlogAdd('A')]);

    expect(text.endsWith('\n')).toBe(true);
    expect(JSON.parse(text.trimEnd())).toEqual(backlogAdd('A'));
  });
});

describe('describeCompaction', () => {
  it('names how many were dropped and how many are still queued', () => {
    const result = {
      records: [backlogAdd('A')],
      dropped: [{ id: 'B', title: 'Gone' }],
      kept: ['A'],
    };

    expect(describeCompaction('backlog', 4, result)).toBe(
      'backlog: 4 records -> 1 (1 finished and dropped, 1 still queued)',
    );
  });
});
