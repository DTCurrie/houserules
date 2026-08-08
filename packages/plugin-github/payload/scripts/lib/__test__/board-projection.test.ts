import { describe, expect, it } from 'vitest';

import {
  fieldValue,
  projectBoardItems,
  stripMarker,
} from '../board-projection.mjs';
import { appendMarker } from '../project-shape.mjs';
import type { BoardItem } from '../board-projection.mjs';

function textField(name: string, text: string) {
  return { __typename: 'ProjectV2ItemFieldTextValue', field: { name }, text };
}

function dateField(name: string, date: string) {
  return { __typename: 'ProjectV2ItemFieldDateValue', field: { name }, date };
}

function selectField(name: string, value: string) {
  return {
    __typename: 'ProjectV2ItemFieldSingleSelectValue',
    field: { name },
    name: value,
  };
}

function numberField(name: string, number: number) {
  return {
    __typename: 'ProjectV2ItemFieldNumberValue',
    field: { name },
    number,
  };
}

function issueItem(overrides: Partial<BoardItem> = {}): BoardItem {
  return {
    id: 'item-1',
    content: {
      __typename: 'Issue',
      number: 42,
      title: 'Fix the thing',
      body: appendMarker('The report body.', 'BACKLOG-abc123'),
      state: 'OPEN',
    },
    fieldValues: { nodes: [] },
    ...overrides,
  };
}

describe('fieldValue', () => {
  it('reads a text field by name', () => {
    const item = issueItem({
      fieldValues: { nodes: [textField('Chat', 'https://chat.example/1')] },
    });

    expect(fieldValue(item, 'Chat')).toBe('https://chat.example/1');
  });

  it('reads a date field by name', () => {
    const item = issueItem({
      fieldValues: { nodes: [dateField('Filed', '2026-08-03')] },
    });

    expect(fieldValue(item, 'Filed')).toBe('2026-08-03');
  });

  it('reads a single-select field by its option name', () => {
    const item = issueItem({
      fieldValues: { nodes: [selectField('Status', 'Accepted')] },
    });

    expect(fieldValue(item, 'Status')).toBe('Accepted');
  });

  it('reads a number field as a string', () => {
    const item = issueItem({
      fieldValues: { nodes: [numberField('Estimate', 3)] },
    });

    expect(fieldValue(item, 'Estimate')).toBe('3');
  });

  it('returns null when the item carries no value for the field', () => {
    const item = issueItem({ fieldValues: { nodes: [] } });

    expect(fieldValue(item, 'Chat')).toBeNull();
  });
});

describe('stripMarker', () => {
  it('removes the marker and the blank line appendMarker inserted', () => {
    const original = 'Reported bug.';
    const withMarker = appendMarker(original, 'BACKLOG-abc123');

    expect(stripMarker(withMarker)).toBe(original);
  });

  it('returns the body unchanged when it carries no marker', () => {
    expect(stripMarker('Just a plain body.')).toBe('Just a plain body.');
  });
});

describe('projectBoardItems for backlog', () => {
  it('reads issue content into a full entry', () => {
    const item = issueItem({
      fieldValues: {
        nodes: [
          dateField('Filed', '2026-08-03'),
          textField('Area', 'plugin-github'),
          textField('Chat', 'https://chat.example/1'),
          selectField('Status', 'Todo'),
        ],
      },
    });

    const { entries, skipped } = projectBoardItems('backlog', [item]);

    expect(entries).toEqual([
      {
        id: 'BACKLOG-abc123',
        itemId: 'item-1',
        issue: 42,
        title: 'Fix the thing',
        body: 'The report body.',
        surface: 'plugin-github.BACKLOG.md',
        date: '2026-08-03',
        chat: 'https://chat.example/1',
        status: 'Todo',
        scope: [],
        under: null,
        supersedes: [],
        supersededBy: null,
      },
    ]);
    expect(skipped).toEqual([]);
  });

  it('projects an unmarked item into unmarked rather than discarding it', () => {
    const item = issueItem({
      content: {
        __typename: 'Issue',
        number: 7,
        title: 'Someone else filed this',
        body: 'No marker in here.',
        state: 'OPEN',
      },
      id: 'item-unmarked',
      fieldValues: {
        nodes: [
          dateField('Filed', '2026-08-06'),
          textField('Area', 'plugin-github'),
        ],
      },
    });

    const { entries, unmarked, skipped } = projectBoardItems('backlog', [item]);

    expect(entries).toEqual([]);
    expect(skipped).toEqual([]);
    expect(unmarked).toEqual([
      {
        id: '',
        itemId: 'item-unmarked',
        issue: 7,
        title: 'Someone else filed this',
        body: 'No marker in here.',
        surface: 'plugin-github.BACKLOG.md',
        date: '2026-08-06',
        chat: null,
        status: null,
        scope: [],
        under: null,
        supersedes: [],
        supersededBy: null,
      },
    ]);
  });

  it('reads draft issue content, which carries no issue number', () => {
    const item = issueItem({
      content: {
        __typename: 'DraftIssue',
        title: 'Draft entry',
        body: appendMarker('Draft body.', 'BACKLOG-draft1'),
      },
      fieldValues: {
        nodes: [dateField('Filed', '2026-08-05'), textField('Area', 'root')],
      },
    });

    const { entries } = projectBoardItems('backlog', [item]);

    expect(entries[0].issue).toBeNull();
    expect(entries[0].title).toBe('Draft entry');
  });

  it('skips an item carrying no content', () => {
    const item = issueItem({ content: null, id: 'item-foreign' });

    const { entries, unmarked, skipped } = projectBoardItems('backlog', [item]);

    expect(entries).toEqual([]);
    expect(unmarked).toEqual([]);
    expect(skipped).toEqual(['item-foreign']);
  });
});

describe('projectBoardItems for decisions', () => {
  it('reads the decisions-only fields and leaves issue null', () => {
    const item = issueItem({
      fieldValues: {
        nodes: [
          dateField('Decided', '2026-08-01'),
          textField('Area', 'cli'),
          textField('Scope', 'src/cli, src/core'),
          textField('Under', 'DECISIONS-parent1'),
          textField('Supersedes', 'DECISIONS-old1, DECISIONS-old2'),
          textField('Superseded by', 'DECISIONS-newer1'),
          textField('Chat', 'https://chat.example/2'),
          selectField('Status', 'Accepted'),
        ],
      },
    });

    const { entries } = projectBoardItems('decisions', [item]);

    expect(entries).toEqual([
      {
        id: 'BACKLOG-abc123',
        itemId: 'item-1',
        issue: null,
        title: 'Fix the thing',
        body: 'The report body.',
        surface: 'cli.DECISIONS.md',
        date: '2026-08-01',
        chat: 'https://chat.example/2',
        status: 'Accepted',
        scope: ['src/cli', 'src/core'],
        under: 'DECISIONS-parent1',
        supersedes: ['DECISIONS-old1', 'DECISIONS-old2'],
        supersededBy: 'DECISIONS-newer1',
      },
    ]);
  });

  it('falls back to empty strings and nulls when fields are absent', () => {
    const item = issueItem({ fieldValues: { nodes: [] } });

    const { entries } = projectBoardItems('decisions', [item]);

    expect(entries).toEqual([
      {
        id: 'BACKLOG-abc123',
        itemId: 'item-1',
        issue: null,
        title: 'Fix the thing',
        body: 'The report body.',
        surface: 'DECISIONS.md',
        date: '',
        chat: null,
        status: null,
        scope: [],
        under: null,
        supersedes: [],
        supersededBy: null,
      },
    ]);
  });
});

describe('fieldValue against a union member the query did not fully spread', () => {
  it('ignores a value node carrying no field rather than throwing', () => {
    const item: BoardItem = {
      id: 'PVTI_1',
      content: { __typename: 'Issue', number: 5, title: 'T', body: 'b' },
      fieldValues: {
        nodes: [
          { __typename: 'ProjectV2ItemFieldRepositoryValue' },
          {
            __typename: 'ProjectV2ItemFieldTextValue',
            text: 'cli',
            field: { name: 'Area' },
          },
        ],
      },
    };

    expect(fieldValue(item, 'Area')).toBe('cli');
  });
});
