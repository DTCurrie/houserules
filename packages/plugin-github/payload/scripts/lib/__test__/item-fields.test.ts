import { describe, expect, it } from 'vitest';

import type { PushOp } from '../push-queue.mjs';
import { fieldValueLiteral, fieldValuesFor } from '../item-fields.mjs';
import { areaForSurface } from '../project-shape.mjs';

const backlogOpBase = {
  entryId: 'TEST-abc123',
  kind: 'backlog' as const,
  surface: 'BACKLOG.md',
  title: 'Fix the thing',
  body: 'Body text.',
  date: '2026-01-01',
  chat: null,
};

const decisionOpBase = {
  entryId: 'TEST-xyz789',
  kind: 'decisions' as const,
  surface: 'DECISIONS.md',
  title: 'Adopt the thing',
  body: 'Decision body.',
  date: '2026-01-01',
  chat: null,
};

describe('areaForSurface', () => {
  it('strips a target-prefixed backlog surface to the target name', () => {
    expect(areaForSurface('agent-kit.BACKLOG.md')).toBe('agent-kit');
  });

  it('names the bare backlog surface as the repo root', () => {
    expect(areaForSurface('BACKLOG.md')).toBe('repo root');
  });

  it('strips a target-prefixed decisions surface to the target name', () => {
    expect(areaForSurface('agent-kit.DECISIONS.md')).toBe('agent-kit');
  });

  it('names the bare decisions surface as the repo root', () => {
    expect(areaForSurface('DECISIONS.md')).toBe('repo root');
  });
});

describe('fieldValuesFor, given a backlog op', () => {
  it('sets Status to Todo for a freshly created issue', () => {
    const op: PushOp = { ...backlogOpBase, op: 'create-issue' };

    expect(fieldValuesFor(op)).toContainEqual({
      field: 'Status',
      kind: 'single-select',
      option: 'Todo',
    });
  });

  it('sets Status to Todo for an attached issue', () => {
    const op: PushOp = { ...backlogOpBase, op: 'attach-issue', issue: 12 };

    expect(fieldValuesFor(op)).toContainEqual({
      field: 'Status',
      kind: 'single-select',
      option: 'Todo',
    });
  });

  it('sets Status to Todo for an updated issue', () => {
    const op: PushOp = { ...backlogOpBase, op: 'update-issue', issue: 12 };

    expect(fieldValuesFor(op)).toContainEqual({
      field: 'Status',
      kind: 'single-select',
      option: 'Todo',
    });
  });

  it('sets Status to Done for a closed issue, not Todo', () => {
    const op: PushOp = {
      ...backlogOpBase,
      op: 'close-issue',
      issue: 12,
      reason: 'completed',
    };

    expect(fieldValuesFor(op)).toContainEqual({
      field: 'Status',
      kind: 'single-select',
      option: 'Done',
    });
  });

  it('records the surface Area alongside Status', () => {
    const op: PushOp = {
      ...backlogOpBase,
      op: 'create-issue',
      surface: 'agent-kit.BACKLOG.md',
    };

    expect(fieldValuesFor(op)).toContainEqual({
      field: 'Area',
      kind: 'text',
      value: 'agent-kit',
    });
  });
});

describe('fieldValuesFor, given a decision op', () => {
  it('sets Status to Accepted for a created draft', () => {
    const op: PushOp = {
      ...decisionOpBase,
      op: 'create-draft',
      supersedes: [],
      chat: null,
      scope: [],
    };

    expect(fieldValuesFor(op)).toContainEqual({
      field: 'Status',
      kind: 'single-select',
      option: 'Accepted',
    });
  });

  it('sets Status to Superseded for a mark-superseded op, not Accepted', () => {
    const op: PushOp = {
      ...decisionOpBase,
      op: 'mark-superseded',
      itemId: 'PVTI_1',
      successorId: 'TEST-new',
    };

    expect(fieldValuesFor(op)).toContainEqual({
      field: 'Status',
      kind: 'single-select',
      option: 'Superseded',
    });
  });

  it('omits Supersedes for a draft with an empty supersedes list', () => {
    const op: PushOp = {
      ...decisionOpBase,
      op: 'create-draft',
      supersedes: [],
      chat: null,
      scope: [],
    };

    expect(
      fieldValuesFor(op).some((value) => value.field === 'Supersedes'),
    ).toBe(false);
  });

  it('joins a two-id supersedes list with a comma and space', () => {
    const op: PushOp = {
      ...decisionOpBase,
      op: 'create-draft',
      supersedes: ['TEST-a', 'TEST-b'],
      chat: null,
      scope: [],
    };

    expect(fieldValuesFor(op)).toContainEqual({
      field: 'Supersedes',
      kind: 'text',
      value: 'TEST-a, TEST-b',
    });
  });

  it('omits Chat for a draft with a null chat', () => {
    const op: PushOp = {
      ...decisionOpBase,
      op: 'create-draft',
      supersedes: [],
      chat: null,
      scope: [],
    };

    expect(fieldValuesFor(op).some((value) => value.field === 'Chat')).toBe(
      false,
    );
  });

  it('includes Chat for a draft with a non-null chat', () => {
    const op: PushOp = {
      ...decisionOpBase,
      op: 'create-draft',
      supersedes: [],
      chat: 'https://claude.ai/chat/abc',
      scope: [],
    };

    expect(fieldValuesFor(op)).toContainEqual({
      field: 'Chat',
      kind: 'text',
      value: 'https://claude.ai/chat/abc',
    });
  });
});

describe('fieldValuesFor, given a report-move op', () => {
  it('returns an empty list', () => {
    const op: PushOp = {
      ...backlogOpBase,
      op: 'report-move',
      issue: 12,
      itemId: null,
      toSurface: 'other.BACKLOG.md',
    };

    expect(fieldValuesFor(op)).toEqual([]);
  });
});

describe('fieldValueLiteral', () => {
  it('builds a text literal', () => {
    expect(
      fieldValueLiteral({ field: 'Area', kind: 'text', value: 'repo root' }),
    ).toBe('{ text: "repo root" }');
  });

  it('escapes a double quote inside a text value', () => {
    expect(
      fieldValueLiteral({
        field: 'Area',
        kind: 'text',
        value: 'the "board"',
      }),
    ).toBe('{ text: "the \\"board\\"" }');
  });

  it('escapes a newline inside a text value', () => {
    expect(
      fieldValueLiteral({
        field: 'Area',
        kind: 'text',
        value: 'line one\nline two',
      }),
    ).toBe('{ text: "line one\\nline two" }');
  });

  it('builds a number literal', () => {
    expect(
      fieldValueLiteral({ field: 'Estimate', kind: 'number', value: 3 }),
    ).toBe('{ number: 3 }');
  });

  it('builds a date literal', () => {
    expect(
      fieldValueLiteral({
        field: 'Decided',
        kind: 'date',
        value: '2026-08-07',
      }),
    ).toBe('{ date: "2026-08-07" }');
  });

  it('builds a single select literal from the given option id', () => {
    expect(
      fieldValueLiteral(
        { field: 'Status', kind: 'single-select', option: 'Todo' },
        'OPT_1',
      ),
    ).toBe('{ singleSelectOptionId: "OPT_1" }');
  });

  it('throws naming the field when a single select has no optionId', () => {
    expect(() =>
      fieldValueLiteral({
        field: 'Status',
        kind: 'single-select',
        option: 'Todo',
      }),
    ).toThrow(/Status/);
  });
});

describe('mark-superseded', () => {
  it('names the successor in Superseded by, which is the field that makes the row navigable', () => {
    const values = fieldValuesFor({
      op: 'mark-superseded',
      entryId: 'DEC-old',
      kind: 'decisions',
      surface: 'agent-kit.DECISIONS.md',
      title: 'Old decision',
      body: '',
      date: '2026-01-01',
      chat: null,
      itemId: 'PVTI_old',
      successorId: 'DEC-new',
    });

    expect(values).toContainEqual({
      field: 'Superseded by',
      kind: 'text',
      value: 'DEC-new',
    });
  });
});

describe('provenance a pulled index cannot derive from the item', () => {
  const BASE = {
    entryId: 'B-1',
    kind: 'backlog' as const,
    surface: 'cli.BACKLOG.md',
    title: 'Fix it',
    body: 'body',
    date: '2026-08-08',
    chat: 'chat-abc' as string | null,
  };

  function backlogOp(
    op: 'create-issue' | 'attach-issue' | 'update-issue',
  ): PushOp {
    if (op === 'create-issue') return { ...BASE, op };
    return { ...BASE, op, issue: 12 };
  }

  it.each(['create-issue', 'attach-issue', 'update-issue'] as const)(
    '%s writes Filed, so the entry does not read ????-??-?? once the queue drains',
    (op) => {
      expect(fieldValuesFor(backlogOp(op))).toContainEqual({
        field: 'Filed',
        kind: 'date',
        value: '2026-08-08',
      });
    },
  );

  it('writes Chat alongside it', () => {
    expect(fieldValuesFor(backlogOp('create-issue'))).toContainEqual({
      field: 'Chat',
      kind: 'text',
      value: 'chat-abc',
    });
  });

  it('omits Chat rather than writing an empty one when there is no session', () => {
    const op: PushOp = { ...BASE, chat: null, op: 'create-issue' };

    expect(fieldValuesFor(op).filter((v) => v.field === 'Chat')).toEqual([]);
  });
});
