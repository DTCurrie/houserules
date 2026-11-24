import { describe, expect, it } from 'vitest';

import {
  rejectedTurnWindows,
  rowsInRejectedTurns,
} from '../rejected-turns.mjs';
import type { LedgerRecord } from '../push-queue.mjs';

const SESSION = 'aaaaaaaa-1111-2222-3333-444444444444';
const OTHER_SESSION = 'bbbbbbbb-1111-2222-3333-444444444444';

const REJECTION_CONTENT =
  "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.";

function prompt(timestamp: string, sessionId = SESSION): string {
  return JSON.stringify({
    type: 'user',
    sessionId,
    timestamp,
    message: { role: 'user', content: 'do the thing' },
  });
}

function toolUse(timestamp: string): string {
  return JSON.stringify({
    type: 'assistant',
    sessionId: SESSION,
    timestamp,
    message: {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: `toolu_${timestamp}`, name: 'Edit', input: {} },
      ],
    },
  });
}

function acceptedResult(timestamp: string): string {
  return JSON.stringify({
    type: 'user',
    sessionId: SESSION,
    timestamp,
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          content: 'The file has been updated successfully.',
          tool_use_id: `toolu_${timestamp}`,
        },
      ],
    },
    permissionDecision: { decision: 'accept', source: 'user_temporary' },
  });
}

function userRejection(
  timestamp: string,
  { sessionId = SESSION, withDenialKind = true } = {},
): string {
  return JSON.stringify({
    type: 'user',
    sessionId,
    timestamp,
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          content: REJECTION_CONTENT,
          is_error: true,
          tool_use_id: `toolu_${timestamp}`,
        },
      ],
    },
    toolUseResult: 'User rejected tool use',
    ...(withDenialKind ? { toolDenialKind: 'user-rejected' } : {}),
  });
}

function hookDenial(timestamp: string): string {
  return JSON.stringify({
    type: 'user',
    sessionId: SESSION,
    timestamp,
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          content: 'PreToolUse:Bash hook error: Blocked by houserules guard.',
          is_error: true,
          tool_use_id: `toolu_${timestamp}`,
        },
      ],
    },
    toolDenialKind: 'permission-rule',
    permissionDecision: { decision: 'reject', source: 'hook' },
  });
}

function ms(iso: string): number {
  return Date.parse(iso);
}

describe('rejectedTurnWindows', () => {
  it('spans a rejected turn from its prompt to the next prompt', () => {
    const lines = [
      prompt('2026-11-24T10:00:00.000Z'),
      toolUse('2026-11-24T10:00:01.000Z'),
      acceptedResult('2026-11-24T10:00:02.000Z'),
      prompt('2026-11-24T10:01:00.000Z'),
      toolUse('2026-11-24T10:01:20.000Z'),
      userRejection('2026-11-24T10:01:30.000Z'),
      prompt('2026-11-24T10:02:00.000Z'),
    ];

    expect(rejectedTurnWindows(lines, SESSION)).toEqual([
      {
        start: ms('2026-11-24T10:01:00.000Z'),
        end: ms('2026-11-24T10:02:00.000Z'),
      },
    ]);
  });

  it('leaves the last turn open-ended when it holds the rejection', () => {
    const lines = [
      prompt('2026-11-24T10:00:00.000Z'),
      userRejection('2026-11-24T10:00:30.000Z'),
    ];

    expect(rejectedTurnWindows(lines, SESSION)).toEqual([
      { start: ms('2026-11-24T10:00:00.000Z'), end: Infinity },
    ]);
  });

  it('keeps a turn whole across the tool results inside it', () => {
    const lines = [
      prompt('2026-11-24T10:00:00.000Z'),
      toolUse('2026-11-24T10:00:01.000Z'),
      acceptedResult('2026-11-24T10:00:02.000Z'),
      toolUse('2026-11-24T10:00:03.000Z'),
      userRejection('2026-11-24T10:00:04.000Z'),
    ];

    expect(rejectedTurnWindows(lines, SESSION)).toEqual([
      { start: ms('2026-11-24T10:00:00.000Z'), end: Infinity },
    ]);
  });

  it('finds no window in a transcript with no rejection', () => {
    const lines = [
      prompt('2026-11-24T10:00:00.000Z'),
      toolUse('2026-11-24T10:00:01.000Z'),
      acceptedResult('2026-11-24T10:00:02.000Z'),
    ];

    expect(rejectedTurnWindows(lines, SESSION)).toEqual([]);
  });

  it('ignores a tool use a hook denied, since the user rejected nothing', () => {
    const lines = [
      prompt('2026-11-24T10:00:00.000Z'),
      hookDenial('2026-11-24T10:00:01.000Z'),
    ];

    expect(rejectedTurnWindows(lines, SESSION)).toEqual([]);
  });

  it('recognizes a rejection by its text when the record carries no toolDenialKind', () => {
    const lines = [
      prompt('2026-11-24T10:00:00.000Z'),
      userRejection('2026-11-24T10:00:30.000Z', { withDenialKind: false }),
    ];

    expect(rejectedTurnWindows(lines, SESSION)).toEqual([
      { start: ms('2026-11-24T10:00:00.000Z'), end: Infinity },
    ]);
  });

  it('ignores a rejection stamped with another session id', () => {
    const lines = [
      prompt('2026-11-24T10:00:00.000Z'),
      userRejection('2026-11-24T10:00:30.000Z', { sessionId: OTHER_SESSION }),
    ];

    expect(rejectedTurnWindows(lines, SESSION)).toEqual([]);
  });

  it('skips a malformed line without losing the turn around it', () => {
    const lines = [
      prompt('2026-11-24T10:00:00.000Z'),
      '{"type":"user","message":',
      userRejection('2026-11-24T10:00:30.000Z'),
      '',
    ];

    expect(rejectedTurnWindows(lines, SESSION)).toEqual([
      { start: ms('2026-11-24T10:00:00.000Z'), end: Infinity },
    ]);
  });
});

describe('rowsInRejectedTurns, given one rejected turn from 10:01:00 to 10:02:00 with its rejection at 10:01:30', () => {
  const windows = [
    {
      start: ms('2026-11-24T10:01:00.000Z'),
      end: ms('2026-11-24T10:02:00.000Z'),
    },
  ];

  function row(overrides: Partial<LedgerRecord>): LedgerRecord {
    return {
      ts: '2026-11-24T10:01:10.000Z',
      id: 'HOUSERULES-aaaaaa',
      action: 'add',
      chat: SESSION,
      ...overrides,
    };
  }

  it.each([
    {
      name: 'holds a row written before the rejection in that turn',
      record: row({ ts: '2026-11-24T10:01:10.000Z' }),
      held: true,
    },
    {
      name: 'holds a row written after the rejection in that turn',
      record: row({ ts: '2026-11-24T10:01:45.000Z' }),
      held: true,
    },
    {
      name: 'holds a row written at the instant the turn started',
      record: row({ ts: '2026-11-24T10:01:00.000Z' }),
      held: true,
    },
    {
      name: 'leaves a row written in the clean turn before it',
      record: row({ ts: '2026-11-24T10:00:30.000Z' }),
      held: false,
    },
    {
      name: 'leaves a row written at the next prompt',
      record: row({ ts: '2026-11-24T10:02:00.000Z' }),
      held: false,
    },
    {
      name: 'leaves a row another session wrote inside the window',
      record: row({ chat: OTHER_SESSION }),
      held: false,
    },
    {
      name: 'leaves a row with chat null inside the window',
      record: row({ chat: null }),
      held: false,
    },
    {
      name: "leaves the executor's own synced record",
      record: {
        ts: '2026-11-24T10:01:10.000Z',
        id: 'HOUSERULES-aaaaaa',
        action: 'synced',
      },
      held: false,
    },
  ])('$name', ({ record, held }) => {
    expect(rowsInRejectedTurns([record], windows, SESSION)).toEqual(
      held ? [record] : [],
    );
  });

  it('holds nothing when there is no rejected turn', () => {
    expect(rowsInRejectedTurns([row({})], [], SESSION)).toEqual([]);
  });
});
