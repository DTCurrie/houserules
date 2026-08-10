import { describe, expect, it } from 'vitest';

import {
  buildPushQueue,
  describeOp,
  resolveMarkSupersededItemId,
  summarizeQueue,
  syncedRecord,
} from '../push-queue.mjs';
import type { LedgerRecord, PushOp } from '../push-queue.mjs';

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
    ...overrides,
  };
}

function decide(
  id: string,
  overrides: Partial<LedgerRecord> = {},
): LedgerRecord {
  return {
    ts: '2026-01-01T00:00:00Z',
    id,
    action: 'decide',
    file: 'DECISIONS.md',
    title: 'Use pnpm',
    content: 'because workspaces',
    ...overrides,
  };
}

function synced(
  id: string,
  overrides: Partial<LedgerRecord> = {},
): LedgerRecord {
  return {
    ts: '2026-01-02T00:00:00Z',
    id,
    action: 'synced',
    ...overrides,
  };
}

describe('buildPushQueue', () => {
  it('produces exactly one create-issue for a fresh backlog add', () => {
    const ops = buildPushQueue([backlogAdd('BL-1')], []);

    expect(ops).toEqual([
      {
        entryId: 'BL-1',
        kind: 'backlog',
        surface: 'BACKLOG.md',
        title: 'Fix the thing',
        body: 'original body',
        date: '2026-01-01',
        chat: null,
        op: 'create-issue',
      },
    ]);
  });

  it('produces an empty queue once the entry carries a matching synced record', () => {
    const ops = buildPushQueue(
      [backlogAdd('BL-1'), synced('BL-1', { issue: 42 })],
      [],
    );

    expect(ops).toEqual([]);
  });

  it('produces update-issue carrying the recorded issue number after a synced update', () => {
    const ops = buildPushQueue(
      [
        backlogAdd('BL-1'),
        synced('BL-1', { issue: 42 }),
        {
          ts: '2026-01-03T00:00:00Z',
          id: 'BL-1',
          action: 'update',
          file: 'BACKLOG.md',
          title: 'Fix the other thing',
          content: 'revised body',
        },
      ],
      [],
    );

    expect(ops).toEqual([
      {
        entryId: 'BL-1',
        kind: 'backlog',
        surface: 'BACKLOG.md',
        title: 'Fix the other thing',
        body: 'revised body',
        date: '2026-01-01',
        chat: null,
        op: 'update-issue',
        issue: 42,
      },
    ]);
  });

  it('produces close-issue with the recorded reason after a synced remove', () => {
    const ops = buildPushQueue(
      [
        backlogAdd('BL-1'),
        synced('BL-1', { issue: 7 }),
        {
          ts: '2026-01-03T00:00:00Z',
          id: 'BL-1',
          action: 'remove',
          file: 'BACKLOG.md',
          reason: 'resolved upstream',
        },
      ],
      [],
    );

    expect(ops).toEqual([
      {
        entryId: 'BL-1',
        kind: 'backlog',
        surface: 'BACKLOG.md',
        title: 'Fix the thing',
        body: 'original body',
        date: '2026-01-01',
        chat: null,
        op: 'close-issue',
        issue: 7,
        reason: 'resolved upstream',
      },
    ]);
  });

  it('produces nothing for a remove with no prior synced record', () => {
    const ops = buildPushQueue(
      [
        backlogAdd('BL-1'),
        {
          ts: '2026-01-02T00:00:00Z',
          id: 'BL-1',
          action: 'remove',
          file: 'BACKLOG.md',
          reason: 'never shipped',
        },
      ],
      [],
    );

    expect(ops).toEqual([]);
  });

  it('yields a synced attach-issue for a backlog entry adopted from an existing issue', () => {
    const ops = buildPushQueue([backlogAdd('BL-1', { issue: 99 })], []);

    expect(ops).toEqual([
      {
        entryId: 'BL-1',
        kind: 'backlog',
        surface: 'BACKLOG.md',
        title: 'Fix the thing',
        body: 'original body',
        date: '2026-01-01',
        chat: null,
        op: 'attach-issue',
        issue: 99,
      },
    ]);
  });

  it('yields report-move with the issue for a synced backlog entry moved to another surface', () => {
    const ops = buildPushQueue(
      [
        backlogAdd('BL-1'),
        synced('BL-1', { issue: 42 }),
        {
          ts: '2026-01-03T00:00:00Z',
          id: 'BL-1',
          action: 'move',
          file: 'studio.BACKLOG.md',
        },
      ],
      [],
    );

    expect(ops).toEqual([
      {
        entryId: 'BL-1',
        kind: 'backlog',
        surface: 'studio.BACKLOG.md',
        title: 'Fix the thing',
        body: 'original body',
        date: '2026-01-01',
        chat: null,
        op: 'report-move',
        issue: 42,
        itemId: null,
        toSurface: 'studio.BACKLOG.md',
      },
    ]);
  });

  it('produces create-draft then mark-superseded carrying the recorded itemId when the target is already synced', () => {
    const ops = buildPushQueue(
      [],
      [
        decide('DEC-1'),
        synced('DEC-1', { itemId: 'PVTI_1' }),
        decide('DEC-2', {
          ts: '2026-01-03T00:00:00Z',
          action: 'supersede',
          title: 'Use pnpm workspaces strictly',
          content: 'because drift',
          supersedes: ['DEC-1'],
        }),
      ],
    );

    expect(ops).toEqual([
      {
        entryId: 'DEC-2',
        kind: 'decisions',
        surface: 'DECISIONS.md',
        title: 'Use pnpm workspaces strictly',
        body: 'because drift',
        date: '2026-01-03',
        chat: null,
        op: 'create-draft',
        supersedes: ['DEC-1'],
        scope: [],
      },
      {
        entryId: 'DEC-1',
        kind: 'decisions',
        surface: 'DECISIONS.md',
        title: 'Use pnpm',
        body: 'because workspaces',
        date: '2026-01-01',
        chat: null,
        op: 'mark-superseded',
        itemId: 'PVTI_1',
        successorId: 'DEC-2',
      },
    ]);
  });

  it('marks a target superseded with a null itemId when nothing in the ledger is synced yet', () => {
    const ops = buildPushQueue(
      [],
      [
        decide('DEC-1'),
        decide('DEC-2', {
          ts: '2026-01-03T00:00:00Z',
          action: 'supersede',
          title: 'Use pnpm workspaces strictly',
          content: 'because drift',
          supersedes: ['DEC-1'],
        }),
      ],
    );

    expect(ops).toEqual([
      {
        entryId: 'DEC-1',
        kind: 'decisions',
        surface: 'DECISIONS.md',
        title: 'Use pnpm',
        body: 'because workspaces',
        date: '2026-01-01',
        chat: null,
        op: 'create-draft',
        supersedes: [],
        scope: [],
      },
      {
        entryId: 'DEC-2',
        kind: 'decisions',
        surface: 'DECISIONS.md',
        title: 'Use pnpm workspaces strictly',
        body: 'because drift',
        date: '2026-01-03',
        chat: null,
        op: 'create-draft',
        supersedes: ['DEC-1'],
        scope: [],
      },
      {
        entryId: 'DEC-1',
        kind: 'decisions',
        surface: 'DECISIONS.md',
        title: 'Use pnpm',
        body: 'because workspaces',
        date: '2026-01-01',
        chat: null,
        op: 'mark-superseded',
        itemId: null,
        successorId: 'DEC-2',
      },
    ]);
  });

  it('routes mark-superseded to the surface the target moved to, not the one it was decided on', () => {
    const ops = buildPushQueue(
      [],
      [
        decide('DEC-1'),
        {
          ts: '2026-01-02T00:00:00Z',
          id: 'DEC-1',
          action: 'move',
          file: 'agent-kit.DECISIONS.md',
        },
        decide('DEC-2', {
          ts: '2026-01-03T00:00:00Z',
          action: 'supersede',
          title: 'Use pnpm workspaces strictly',
          content: 'because drift',
          supersedes: ['DEC-1'],
        }),
      ],
    );
    const markOp = ops.find((op) => op.op === 'mark-superseded');

    expect(markOp).toMatchObject({ surface: 'agent-kit.DECISIONS.md' });
  });

  it('names the recorded itemId when the target syncs after the supersede record', () => {
    const ops = buildPushQueue(
      [],
      [
        decide('DEC-1'),
        decide('DEC-2', {
          ts: '2026-01-02T00:00:00Z',
          action: 'supersede',
          title: 'Use pnpm workspaces strictly',
          content: 'because drift',
          supersedes: ['DEC-1'],
        }),
        synced('DEC-1', { itemId: 'PVTI_lAHOAB10g84BfuHMzg1vIwM' }),
      ],
    );
    const markOp = ops.find((op) => op.op === 'mark-superseded');

    expect(markOp).toMatchObject({ itemId: 'PVTI_lAHOAB10g84BfuHMzg1vIwM' });
  });

  it('produces no mark-superseded when the named target appears nowhere in the ledger', () => {
    const ops = buildPushQueue(
      [],
      [
        decide('DEC-2', {
          ts: '2026-01-03T00:00:00Z',
          action: 'supersede',
          title: 'Use pnpm workspaces strictly',
          content: 'because drift',
          supersedes: ['DEC-1'],
        }),
      ],
    );

    expect(ops).toEqual([
      {
        entryId: 'DEC-2',
        kind: 'decisions',
        surface: 'DECISIONS.md',
        title: 'Use pnpm workspaces strictly',
        body: 'because drift',
        date: '2026-01-03',
        chat: null,
        op: 'create-draft',
        supersedes: ['DEC-1'],
        scope: [],
      },
    ]);
  });

  it('produces update-draft carrying the new scope after a synced rescope', () => {
    const ops = buildPushQueue(
      [],
      [
        decide('DEC-1', { scope: ['packages/cli'] }),
        synced('DEC-1', { itemId: 'PVTI_1' }),
        {
          ts: '2026-01-03T00:00:00Z',
          id: 'DEC-1',
          action: 'rescope',
          file: 'DECISIONS.md',
          scope: ['packages/plugin-github'],
        },
      ],
    );

    expect(ops).toEqual([
      {
        entryId: 'DEC-1',
        kind: 'decisions',
        surface: 'DECISIONS.md',
        title: 'Use pnpm',
        body: 'because workspaces',
        date: '2026-01-01',
        chat: null,
        op: 'update-draft',
        itemId: 'PVTI_1',
        scope: ['packages/plugin-github'],
      },
    ]);
  });

  it('keeps a shared id from bleeding between the backlog and decision ledgers', () => {
    const ops = buildPushQueue(
      [backlogAdd('SHARE-1'), synced('SHARE-1', { issue: 99 })],
      [decide('SHARE-1', { title: 'Adopt shared prefix', content: 'why' })],
    );

    expect(ops).toEqual([
      {
        entryId: 'SHARE-1',
        kind: 'decisions',
        surface: 'DECISIONS.md',
        title: 'Adopt shared prefix',
        body: 'why',
        date: '2026-01-01',
        chat: null,
        op: 'create-draft',
        supersedes: [],
        scope: [],
      },
    ]);
  });
});

describe('summarizeQueue', () => {
  it('counts pending ops per ledger kind, ignoring report-move', () => {
    const ops: PushOp[] = [
      {
        entryId: 'BL-1',
        kind: 'backlog',
        surface: 'BACKLOG.md',
        title: 'a',
        body: 'b',
        date: '2026-01-01',
        chat: null,
        op: 'create-issue',
      },
      {
        entryId: 'BL-2',
        kind: 'backlog',
        surface: 'BACKLOG.md',
        title: 'a',
        body: 'b',
        date: '2026-01-01',
        chat: null,
        op: 'report-move',
        issue: 1,
        itemId: null,
        toSurface: 'studio.BACKLOG.md',
      },
      {
        entryId: 'DEC-1',
        kind: 'decisions',
        surface: 'DECISIONS.md',
        title: 'a',
        body: 'b',
        date: '2026-01-01',
        chat: null,
        op: 'create-draft',
        supersedes: [],
        scope: [],
      },
    ];

    expect(summarizeQueue(ops)).toEqual({
      backlogPending: 1,
      decisionsPending: 1,
    });
  });

  it('counts mark-superseded toward decisionsPending, since it is a real write', () => {
    const ops: PushOp[] = [
      {
        entryId: 'DEC-1',
        kind: 'decisions',
        surface: 'DECISIONS.md',
        title: 'a',
        body: 'b',
        date: '2026-01-01',
        chat: null,
        op: 'mark-superseded',
        itemId: null,
        successorId: 'DEC-2',
      },
    ];

    expect(summarizeQueue(ops)).toEqual({
      backlogPending: 0,
      decisionsPending: 1,
    });
  });

  it('returns zero counts for an empty queue', () => {
    expect(summarizeQueue([])).toEqual({
      backlogPending: 0,
      decisionsPending: 0,
    });
  });
});

describe('syncedRecord', () => {
  it('carries the issue number for a backlog op', () => {
    const op: PushOp = {
      entryId: 'BL-1',
      kind: 'backlog',
      surface: 'BACKLOG.md',
      title: 'a',
      body: 'b',
      date: '2026-01-01',
      chat: null,
      op: 'create-issue',
    };

    expect(syncedRecord(op, { issue: 42 }, '2026-01-05T00:00:00Z')).toEqual({
      action: 'synced',
      id: 'BL-1',
      op: 'create-issue',
      ts: '2026-01-05T00:00:00Z',
      issue: 42,
    });
  });

  it('carries the item id for a decision op, omitting issue entirely', () => {
    const op: PushOp = {
      entryId: 'DEC-1',
      kind: 'decisions',
      surface: 'DECISIONS.md',
      title: 'a',
      body: 'b',
      date: '2026-01-01',
      chat: null,
      op: 'create-draft',
      supersedes: [],
      scope: [],
    };

    expect(
      syncedRecord(op, { itemId: 'PVTI_9' }, '2026-01-05T00:00:00Z'),
    ).toEqual({
      action: 'synced',
      id: 'DEC-1',
      op: 'create-draft',
      ts: '2026-01-05T00:00:00Z',
      itemId: 'PVTI_9',
    });
  });
});

describe('describeOp', () => {
  it('reports a decision report-move with no issue as unable to move', () => {
    const op: PushOp = {
      entryId: 'DEC-1',
      kind: 'decisions',
      surface: 'DECISIONS.md',
      title: 'a',
      body: 'b',
      date: '2026-01-01',
      chat: null,
      op: 'report-move',
      issue: null,
      itemId: 'PVTI_1',
      toSurface: 'cli.DECISIONS.md',
    };

    expect(describeOp(op)).toBe(
      'report-move DEC-1: decision cannot move to cli.DECISIONS.md',
    );
  });

  it('reports a backlog report-move with an issue as adding it to the new surface', () => {
    const op: PushOp = {
      entryId: 'BL-1',
      kind: 'backlog',
      surface: 'BACKLOG.md',
      title: 'a',
      body: 'b',
      date: '2026-01-01',
      chat: null,
      op: 'report-move',
      issue: 42,
      itemId: null,
      toSurface: 'cli.BACKLOG.md',
    };

    expect(describeOp(op)).toBe(
      'report-move BL-1: add issue #42 to cli.BACKLOG.md',
    );
  });

  it('describes a non-report-move op by its op, entry id, kind, and surface', () => {
    const op: PushOp = {
      entryId: 'BL-2',
      kind: 'backlog',
      surface: 'BACKLOG.md',
      title: 'a',
      body: 'b',
      date: '2026-01-01',
      chat: null,
      op: 'create-issue',
    };

    expect(describeOp(op)).toBe('create-issue BL-2 (backlog) -> BACKLOG.md');
  });
});

describe('resolveMarkSupersededItemId', () => {
  it('returns the item id directly when the op already carries one', () => {
    const result = resolveMarkSupersededItemId(
      { itemId: 'PVTI_9', entryId: 'DEC-1' },
      new Map(),
    );

    expect(result).toEqual({ ok: true, value: 'PVTI_9' });
  });

  it('resolves a null item id against a draft created earlier in the same run', () => {
    const result = resolveMarkSupersededItemId(
      { itemId: null, entryId: 'DEC-1' },
      new Map([['DEC-1', 'PVTI_7']]),
    );

    expect(result).toEqual({ ok: true, value: 'PVTI_7' });
  });

  it('errors when the item id is null and no draft was created for the entry this run', () => {
    const result = resolveMarkSupersededItemId(
      { itemId: null, entryId: 'DEC-1' },
      new Map(),
    );

    expect(result).toEqual({
      ok: false,
      status: null,
      message:
        'cannot mark DEC-1 superseded: its item id is unknown, its create-draft failed earlier this run',
    });
  });
});

describe('mark-superseded idempotency', () => {
  it('stops emitting once a synced record acknowledges the flip', () => {
    const decisions = [
      {
        ts: '2026-01-01T00:00:00Z',
        id: 'D-old',
        action: 'decide',
        file: 'DECISIONS.md',
        title: 'Old',
        content: '',
      },
      {
        ts: '2026-01-02T00:00:00Z',
        id: 'D-new',
        action: 'supersede',
        file: 'DECISIONS.md',
        title: 'New',
        content: '',
        supersedes: ['D-old'],
      },
      {
        ts: '2026-01-03T00:00:00Z',
        id: 'D-old',
        action: 'synced',
        op: 'create-draft',
        itemId: 'PVTI_old',
      },
      {
        ts: '2026-01-03T00:00:01Z',
        id: 'D-new',
        action: 'synced',
        op: 'create-draft',
        itemId: 'PVTI_new',
      },
      {
        ts: '2026-01-03T00:00:02Z',
        id: 'D-old',
        action: 'synced',
        op: 'mark-superseded',
        itemId: 'PVTI_old',
      },
    ];

    expect(buildPushQueue([], decisions)).toEqual([]);
  });

  it('still emits the flip when only the draft is acknowledged', () => {
    const decisions = [
      {
        ts: '2026-01-01T00:00:00Z',
        id: 'D-old',
        action: 'decide',
        file: 'DECISIONS.md',
        title: 'Old',
        content: '',
      },
      {
        ts: '2026-01-02T00:00:00Z',
        id: 'D-new',
        action: 'supersede',
        file: 'DECISIONS.md',
        title: 'New',
        content: '',
        supersedes: ['D-old'],
      },
      {
        ts: '2026-01-03T00:00:00Z',
        id: 'D-old',
        action: 'synced',
        op: 'create-draft',
        itemId: 'PVTI_old',
      },
      {
        ts: '2026-01-03T00:00:01Z',
        id: 'D-new',
        action: 'synced',
        op: 'create-draft',
        itemId: 'PVTI_new',
      },
    ];

    expect(buildPushQueue([], decisions).map((o) => o.op)).toEqual([
      'mark-superseded',
    ]);
  });
});

describe('body encoding', () => {
  it('passes content through untouched, so the caller owns decoding', () => {
    const backlog = [
      {
        ts: '2026-01-01T00:00:00Z',
        id: 'BL-1',
        action: 'add',
        file: 'BACKLOG.md',
        title: 'Thing',
        content: 'plain readable body',
      },
    ];

    expect(buildPushQueue(backlog, [])[0]?.body).toBe('plain readable body');
  });

  it('carries a multi-line body through without reflowing it', () => {
    const backlog = [
      {
        ts: '2026-01-01T00:00:00Z',
        id: 'BL-1',
        action: 'add',
        file: 'BACKLOG.md',
        title: 'Thing',
        content: 'first line\n\nsecond paragraph',
      },
    ];

    expect(buildPushQueue(backlog, [])[0]?.body).toBe(
      'first line\n\nsecond paragraph',
    );
  });
});

describe('close-issue idempotency', () => {
  const removed = [
    {
      ts: '2026-01-01T00:00:00Z',
      id: 'BL-1',
      action: 'add',
      file: 'BACKLOG.md',
      title: 'Thing',
      content: 'body',
    },
    {
      ts: '2026-01-02T00:00:00Z',
      id: 'BL-1',
      action: 'synced',
      op: 'create-issue',
      issue: 7,
    },
    {
      ts: '2026-01-03T00:00:00Z',
      id: 'BL-1',
      action: 'remove',
      file: 'BACKLOG.md',
      reason: 'done',
    },
  ];

  it('emits the close once while it is unacknowledged', () => {
    expect(buildPushQueue(removed, []).map((o) => o.op)).toEqual([
      'close-issue',
    ]);
  });

  it('stops emitting once a synced record acknowledges the close', () => {
    const acknowledged = [
      ...removed,
      {
        ts: '2026-01-04T00:00:00Z',
        id: 'BL-1',
        action: 'synced',
        op: 'close-issue',
        issue: 7,
      },
    ];

    expect(buildPushQueue(acknowledged, [])).toEqual([]);
  });
});

describe('an entry that exists only in the index, its queue records long gone', () => {
  function indexed(overrides: Record<string, unknown> = {}) {
    return {
      id: 'D-1',
      itemId: 'item-1',
      issue: null,
      title: 'Adopt wireit',
      body: 'because',
      surface: 'cli.DECISIONS.md',
      date: '2026-08-06',
      chat: null,
      status: 'Accepted',
      scope: ['packages/cli'],
      under: null,
      supersedes: [],
      supersededBy: null,
      ...overrides,
    };
  }

  it('emits nothing when the queue is empty, so a synced entry is not re-pushed', () => {
    expect(buildPushQueue([], [], [], [indexed()])).toEqual([]);
  });

  it('flips to Superseded when a queue-only decision supersedes it', () => {
    const queue = [
      {
        ts: '2026-08-08T00:00:00Z',
        id: 'D-2',
        action: 'supersede',
        file: 'cli.DECISIONS.md',
        title: 'Replaced it',
        content: 'why',
        supersedes: ['D-1'],
      },
    ];

    const ops = buildPushQueue([], queue, [], [indexed()]);

    expect(ops).toContainEqual(
      expect.objectContaining({
        op: 'mark-superseded',
        entryId: 'D-1',
        itemId: 'item-1',
        successorId: 'D-2',
      }),
    );
  });

  it('does not re-flip one the board already reports as Superseded', () => {
    const queue = [
      {
        ts: '2026-08-08T00:00:00Z',
        id: 'D-2',
        action: 'supersede',
        file: 'cli.DECISIONS.md',
        title: 'Replaced it',
        content: 'why',
        supersedes: ['D-1'],
      },
    ];

    const ops = buildPushQueue(
      [],
      queue,
      [],
      [indexed({ status: 'Superseded' })],
    );

    expect(ops.filter((op) => op.op === 'mark-superseded')).toEqual([]);
  });

  it('amends an index-only decision against the item id the board recorded', () => {
    const queue = [
      {
        ts: '2026-08-08T00:00:00Z',
        id: 'D-1',
        action: 'amend',
        content: 'revised body',
      },
    ];

    expect(buildPushQueue([], queue, [], [indexed()])).toContainEqual({
      entryId: 'D-1',
      kind: 'decisions',
      surface: 'cli.DECISIONS.md',
      title: 'Adopt wireit',
      body: 'revised body',
      date: '2026-08-06',
      chat: null,
      op: 'update-draft',
      itemId: 'item-1',
      scope: ['packages/cli'],
    });
  });

  it('closes an index-only backlog entry against the issue the board recorded', () => {
    const backlogIndex = [
      indexed({
        id: 'B-1',
        issue: 42,
        itemId: '',
        surface: 'cli.BACKLOG.md',
        status: 'Todo',
      }),
    ];
    const queue = [
      {
        ts: '2026-08-08T00:00:00Z',
        id: 'B-1',
        action: 'remove',
        reason: 'done',
      },
    ];

    expect(buildPushQueue(queue, [], backlogIndex, [])).toContainEqual(
      expect.objectContaining({ op: 'close-issue', entryId: 'B-1', issue: 42 }),
    );
  });

  it('does not re-close one the board already reports as Done', () => {
    const backlogIndex = [
      indexed({ id: 'B-1', issue: 42, itemId: '', status: 'Done' }),
    ];
    const queue = [
      {
        ts: '2026-08-08T00:00:00Z',
        id: 'B-1',
        action: 'remove',
        reason: 'done',
      },
    ];

    expect(buildPushQueue(queue, [], backlogIndex, [])).toEqual([]);
  });
});

describe('an entry present in BOTH the index and the queue', () => {
  function indexedDecision(overrides: Record<string, unknown> = {}) {
    return {
      id: 'D-1',
      itemId: 'item-1',
      issue: null,
      title: 'Adopt wireit',
      body: 'because',
      surface: 'cli.DECISIONS.md',
      date: '2026-08-06',
      chat: null,
      status: 'Accepted',
      scope: ['packages/cli'],
      under: null,
      supersedes: [],
      supersededBy: null,
      ...overrides,
    };
  }

  const birth = {
    ts: '2026-08-06T00:00:00Z',
    id: 'D-1',
    action: 'decide',
    file: 'cli.DECISIONS.md',
    title: 'Adopt wireit',
    content: 'because',
    scope: ['packages/cli'],
  };

  it('is not created a second time, because its birth record is still in the queue', () => {
    expect(buildPushQueue([], [birth], [], [indexedDecision()])).toEqual([]);
  });

  it('updates rather than creates when the queue body differs from the board', () => {
    const revised = { ...birth, content: 'revised reasoning' };

    const ops = buildPushQueue([], [revised], [], [indexedDecision()]);

    expect(ops).toEqual([
      expect.objectContaining({
        op: 'update-draft',
        entryId: 'D-1',
        itemId: 'item-1',
      }),
    ]);
  });

  it('does the same for a backlog entry, so an add in the queue never duplicates an issue', () => {
    const backlogBirth = {
      ts: '2026-08-06T00:00:00Z',
      id: 'B-1',
      action: 'add',
      file: 'cli.BACKLOG.md',
      title: 'Fix it',
      content: 'body',
    };
    const index = [
      indexedDecision({
        id: 'B-1',
        issue: 42,
        itemId: '',
        title: 'Fix it',
        body: 'body',
        surface: 'cli.BACKLOG.md',
        status: 'Todo',
        scope: [],
      }),
    ];

    expect(buildPushQueue([backlogBirth], [], index, [])).toEqual([]);
  });
});
