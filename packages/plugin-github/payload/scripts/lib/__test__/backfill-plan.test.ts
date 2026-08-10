import { describe, expect, it } from 'vitest';

import {
  backfillIsNoop,
  describeBackfillOp,
  planBackfill,
} from '../backfill-plan.mjs';
import type { BackfillOp, LocalEntry } from '../backfill-plan.mjs';
import { projectBoardItems } from '../board-projection.mjs';
import { appendMarker } from '../project-shape.mjs';
import type { BoardEntry, BoardItem } from '../board-projection.mjs';

function localEntry(overrides: Partial<LocalEntry> = {}): LocalEntry {
  return {
    id: 'DEC-1',
    title: 'Adopt wireit',
    surface: 'cli',
    date: '2026-08-06',
    chat: 'chat-123',
    scope: [],
    under: null,
    ...overrides,
  };
}

function boardEntry(overrides: Partial<BoardEntry> = {}): BoardEntry {
  return {
    id: 'DEC-1',
    itemId: 'PVTI_1',
    issue: null,
    title: 'Adopt wireit',
    body: 'Some body text',
    surface: 'cli',
    date: '2026-08-06',
    chat: 'chat-123',
    status: 'Accepted',
    scope: [],
    under: null,
    supersedes: [],
    supersededBy: null,
    ...overrides,
  };
}

describe('planBackfill', () => {
  it('matches a marked item by id and emits no ops when every field is already correct', () => {
    const local = [localEntry()];
    const board = [boardEntry()];

    const plan = planBackfill('decisions', local, board);

    expect(plan.ops).toEqual([]);
    expect(plan.unmatched).toEqual([]);
    expect(plan.ambiguous).toEqual([]);
  });

  it('matches an unmarked item by exact title and appends a marker', () => {
    const local = [localEntry({ id: 'DEC-2', title: 'Rename the ledger' })];
    const board = [
      boardEntry({
        id: '',
        title: 'Rename the ledger',
        body: 'The original body',
      }),
    ];

    const plan = planBackfill('decisions', local, board);

    expect(plan.ops).toContainEqual({
      op: 'append-marker',
      itemId: 'PVTI_1',
      entryId: 'DEC-2',
      body: 'The original body',
    });
  });

  it('reports a title matching two local entries as ambiguous and emits no ops for it', () => {
    const local = [
      localEntry({ id: 'DEC-1', title: 'Split the ledger' }),
      localEntry({ id: 'DEC-2', title: 'Split the ledger' }),
    ];
    const board = [boardEntry({ id: '', title: 'Split the ledger' })];

    const plan = planBackfill('decisions', local, board);

    expect(plan.ambiguous).toEqual(['Split the ledger']);
    expect(plan.ops).toEqual([]);
    expect(plan.unmatched).toEqual([]);
  });

  it('records one ambiguous title even when two board items share it', () => {
    const local = [
      localEntry({ id: 'DEC-1', title: 'Split the ledger' }),
      localEntry({ id: 'DEC-2', title: 'Split the ledger' }),
    ];
    const board = [
      boardEntry({ id: '', itemId: 'PVTI_1', title: 'Split the ledger' }),
      boardEntry({ id: '', itemId: 'PVTI_2', title: 'Split the ledger' }),
    ];

    const plan = planBackfill('decisions', local, board);

    expect(plan.ambiguous).toEqual(['Split the ledger']);
  });

  it('reports a marked item with no matching local entry as unmatched', () => {
    const board = [boardEntry({ id: 'DEC-9', itemId: 'PVTI_5' })];

    const plan = planBackfill('decisions', [], board);

    expect(plan.unmatched).toEqual(['PVTI_5']);
    expect(plan.ops).toEqual([]);
    expect(plan.ambiguous).toEqual([]);
  });

  it('reports an unmarked item with no matching title as unmatched', () => {
    const local = [localEntry({ title: 'Adopt wireit' })];
    const board = [
      boardEntry({ id: '', itemId: 'PVTI_5', title: 'A foreign issue' }),
    ];

    const plan = planBackfill('decisions', local, board);

    expect(plan.unmatched).toEqual(['PVTI_5']);
  });

  it('emits set-field only for a decisions field that differs from the board', () => {
    const local = [
      localEntry({ under: 'ledger-sync', surface: 'cli', chat: 'chat-123' }),
    ];
    const board = [boardEntry({ under: null, surface: 'cli' })];

    const plan = planBackfill('decisions', local, board);

    expect(plan.ops).toEqual([
      {
        op: 'set-field',
        itemId: 'PVTI_1',
        entryId: 'DEC-1',
        field: 'Under',
        value: 'ledger-sync',
      },
    ]);
  });

  it('joins a scope list with joinListField and writes it as one Scope value', () => {
    const local = [localEntry({ scope: ['packages/cli', 'packages/test'] })];
    const board = [boardEntry({ scope: [] })];

    const plan = planBackfill('decisions', local, board);

    expect(plan.ops).toEqual([
      {
        op: 'set-field',
        itemId: 'PVTI_1',
        entryId: 'DEC-1',
        field: 'Scope',
        value: 'packages/cli, packages/test',
      },
    ]);
  });

  it('skips an empty local scope list rather than writing a blank field', () => {
    const local = [localEntry({ scope: [] })];
    const board = [boardEntry({ scope: ['packages/cli'] })];

    const plan = planBackfill('decisions', local, board);

    expect(plan.ops).toEqual([]);
  });

  it('skips a null local chat rather than writing a blank field', () => {
    const local = [localEntry({ chat: null })];
    const board = [boardEntry({ chat: 'chat-123' })];

    const plan = planBackfill('decisions', local, board);

    expect(plan.ops).toEqual([]);
  });

  it('maps backlog fields to Filed and Chat rather than Decided/Surface/Under/Scope', () => {
    const local = [
      localEntry({
        id: 'BL-1',
        date: '2026-08-08',
        chat: 'chat-999',
      }),
    ];
    const board = [
      boardEntry({
        id: 'BL-1',
        date: '2026-08-01',
        chat: 'chat-000',
      }),
    ];

    const plan = planBackfill('backlog', local, board);

    expect(plan.ops).toEqual([
      {
        op: 'set-field',
        itemId: 'PVTI_1',
        entryId: 'BL-1',
        field: 'Filed',
        value: '2026-08-08',
      },
      {
        op: 'set-field',
        itemId: 'PVTI_1',
        entryId: 'BL-1',
        field: 'Chat',
        value: 'chat-999',
      },
    ]);
  });

  it('is idempotent, returning an empty plan on a second run over an already-backfilled board', () => {
    const local = [
      localEntry({
        under: 'ledger-sync',
        scope: ['packages/cli'],
      }),
    ];
    const firstBoard = [
      boardEntry({ id: '', under: null, scope: [], body: 'Original body' }),
    ];

    const firstPlan = planBackfill('decisions', local, firstBoard);

    const backfilledBoard = [
      boardEntry({
        id: 'DEC-1',
        under: 'ledger-sync',
        scope: ['packages/cli'],
        body: 'Original body',
      }),
    ];
    const secondPlan = planBackfill('decisions', local, backfilledBoard);

    expect(firstPlan.ops).toEqual([
      {
        op: 'append-marker',
        itemId: 'PVTI_1',
        entryId: 'DEC-1',
        body: 'Original body',
      },
      {
        op: 'set-field',
        itemId: 'PVTI_1',
        entryId: 'DEC-1',
        field: 'Under',
        value: 'ledger-sync',
      },
      {
        op: 'set-field',
        itemId: 'PVTI_1',
        entryId: 'DEC-1',
        field: 'Scope',
        value: 'packages/cli',
      },
    ]);
    expect(secondPlan.ops).toEqual([]);
    expect(backfillIsNoop(secondPlan)).toBe(true);
  });
});

describe('backfillIsNoop', () => {
  it('is true for an empty ops list', () => {
    expect(backfillIsNoop({ ops: [], unmatched: [], ambiguous: [] })).toBe(
      true,
    );
  });

  it('is false when the plan carries at least one op', () => {
    const op: BackfillOp = {
      op: 'append-marker',
      itemId: 'PVTI_1',
      entryId: 'DEC-1',
      body: 'body',
    };

    expect(backfillIsNoop({ ops: [op], unmatched: [], ambiguous: [] })).toBe(
      false,
    );
  });
});

describe('describeBackfillOp', () => {
  it('describes an append-marker op naming the entry id', () => {
    const op: BackfillOp = {
      op: 'append-marker',
      itemId: 'PVTI_1',
      entryId: 'DEC-1',
      body: 'body',
    };

    expect(describeBackfillOp(op)).toBe('append entry marker for DEC-1');
  });

  it('describes a set-field op naming the field and the entry id', () => {
    const op: BackfillOp = {
      op: 'set-field',
      itemId: 'PVTI_1',
      entryId: 'DEC-1',
      field: 'Under',
      value: 'ledger-sync',
    };

    expect(describeBackfillOp(op)).toBe('set Under for DEC-1');
  });
});

describe('planBackfill over a projection of real board items', () => {
  function draftItem(itemId: string, title: string, body: string): BoardItem {
    return {
      id: itemId,
      content: { __typename: 'DraftIssue', title, body },
      fieldValues: {
        nodes: [
          {
            __typename: 'ProjectV2ItemFieldSingleSelectValue',
            name: 'Accepted',
            field: { name: 'Status' },
          },
          {
            __typename: 'ProjectV2ItemFieldDateValue',
            date: '2026-08-06',
            field: { name: 'Decided' },
          },
        ],
      },
    };
  }

  function planFromItems(local: LocalEntry[], items: BoardItem[]) {
    const projection = projectBoardItems('decisions', items);
    return planBackfill('decisions', local, [
      ...projection.entries,
      ...projection.unmarked,
    ]);
  }

  it('reaches a draft that carries no marker, which is every decision on the live board', () => {
    const local = [
      localEntry({
        id: 'DEC-9',
        title: 'Adopt wireit',
        scope: ['packages/cli'],
      }),
    ];
    const items = [draftItem('PVTI_9', 'Adopt wireit', 'Some body text')];

    const plan = planFromItems(local, items);

    expect(plan.ops).toContainEqual({
      op: 'append-marker',
      itemId: 'PVTI_9',
      entryId: 'DEC-9',
      body: 'Some body text',
    });
    expect(plan.ops).toContainEqual({
      op: 'set-field',
      itemId: 'PVTI_9',
      entryId: 'DEC-9',
      field: 'Scope',
      value: 'packages/cli',
    });
  });

  it('leaves a draft alone once its marker and fields have landed', () => {
    const local = [localEntry({ id: 'DEC-9', title: 'Adopt wireit' })];
    const items = [
      draftItem(
        'PVTI_9',
        'Adopt wireit',
        'Some body text\n\n<!-- agent-kit:entry:DEC-9 -->',
      ),
    ];
    items[0].fieldValues.nodes.push(
      {
        __typename: 'ProjectV2ItemFieldTextValue',
        text: 'chat-123',
        field: { name: 'Chat' },
      },
      {
        __typename: 'ProjectV2ItemFieldTextValue',
        text: 'cli',
        field: { name: 'Surface' },
      },
    );

    expect(backfillIsNoop(planFromItems(local, items))).toBe(true);
  });
});

describe('a backfilled board rebuilds the entry it was filled from', () => {
  function applyOps(item: BoardItem, ops: readonly BackfillOp[]): BoardItem {
    let next = item;
    for (const op of ops) {
      if (op.op === 'append-marker') {
        next = {
          ...next,
          content: {
            ...next.content!,
            body: appendMarker(next.content!.body ?? '', op.entryId),
          },
        };
        continue;
      }
      next = {
        ...next,
        fieldValues: {
          nodes: [
            ...next.fieldValues.nodes.filter(
              (node) => node.field?.name !== op.field,
            ),
            {
              __typename: 'ProjectV2ItemFieldTextValue',
              text: op.value,
              field: { name: op.field },
            },
          ],
        },
      };
    }
    return next;
  }

  it('recovers scope, surface, and date that lived only in the local ledger', () => {
    const entry = localEntry({
      id: 'DEC-7',
      title: 'Split the ledger',
      surface: 'agent-kit.DECISIONS.md',
      date: '2026-08-06',
      scope: ['packages/cli/src', 'packages/plugin-github'],
    });
    const bare: BoardItem = {
      id: 'PVTI_7',
      content: {
        __typename: 'DraftIssue',
        title: 'Split the ledger',
        body: 'The reasoning',
      },
      fieldValues: { nodes: [] },
    };

    const plan = planBackfill(
      'decisions',
      [entry],
      [...projectBoardItems('decisions', [bare]).unmarked],
    );
    const [rebuilt] = projectBoardItems('decisions', [
      applyOps(bare, plan.ops),
    ]).entries;

    expect(rebuilt).toMatchObject({
      id: 'DEC-7',
      title: 'Split the ledger',
      surface: 'agent-kit.DECISIONS.md',
      date: '2026-08-06',
      scope: ['packages/cli/src', 'packages/plugin-github'],
      body: 'The reasoning',
    });
  });
});

describe('planBackfill for backlog', () => {
  it('corrects an Area the board disagrees with, for the same reason decisions get one', () => {
    const local = [
      localEntry({ id: 'B-1', surface: 'plugin-backlog.BACKLOG.md' }),
    ];
    const board = [
      boardEntry({ id: 'B-1', surface: 'agent-kit.BACKLOG.md', issue: 12 }),
    ];

    expect(planBackfill('backlog', local, board).ops).toContainEqual({
      op: 'set-field',
      itemId: 'PVTI_1',
      entryId: 'B-1',
      field: 'Area',
      value: 'plugin-backlog',
    });
  });

  it('emits no Area op when the board already agrees', () => {
    const local = [localEntry({ id: 'B-1', surface: 'cli.BACKLOG.md' })];
    const board = [boardEntry({ id: 'B-1', surface: 'cli.BACKLOG.md' })];

    expect(
      planBackfill('backlog', local, board).ops.filter(
        (op) => op.op === 'set-field' && op.field === 'Area',
      ),
    ).toEqual([]);
  });
});
