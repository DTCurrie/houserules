import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  READ_ONLY_TOOLS,
  toolUsesSinceLastPrompt,
  turnStartedAt,
  turnTouchedFiles,
  type TurnRecord,
} from '../transcript-turn.mjs';

function prompt(text = 'do the thing'): TurnRecord {
  return { type: 'user', message: { content: text } };
}

function promptAt(timestamp: string): TurnRecord {
  return { ...prompt(), timestamp };
}

function taskNotificationAt(timestamp: string): TurnRecord {
  return {
    type: 'user',
    timestamp,
    origin: { kind: 'task-notification' },
    message: { content: '<task-notification>done</task-notification>' },
  };
}

function compactSummary(): TurnRecord {
  return {
    type: 'user',
    isCompactSummary: true,
    message: { content: 'This session is being continued' },
  };
}

function metaPrompt(): TurnRecord {
  return { type: 'user', isMeta: true, message: { content: 'caveat' } };
}

function toolResult(): TurnRecord {
  return {
    type: 'user',
    message: { content: [{ type: 'tool_result', content: 'ok' }] },
  };
}

function assistant(...tools: string[]): TurnRecord {
  return {
    type: 'assistant',
    message: {
      content: [
        { type: 'text', text: 'working' },
        ...tools.map((name) => ({ type: 'tool_use', name, input: {} })),
      ],
    },
  };
}

describe('toolUsesSinceLastPrompt', () => {
  it('collects the tool names used since the last human prompt, in order', () => {
    const records = [
      prompt('earlier'),
      assistant('Edit'),
      toolResult(),
      assistant(),
      prompt(),
      assistant('Read', 'Grep'),
      toolResult(),
      toolResult(),
      assistant('Bash'),
      toolResult(),
      assistant(),
    ];
    expect(toolUsesSinceLastPrompt(records)).toEqual(['Read', 'Grep', 'Bash']);
  });

  it('returns an empty list for a turn that used no tools', () => {
    expect(toolUsesSinceLastPrompt([prompt(), assistant()])).toEqual([]);
  });

  it('returns null when no assistant record follows the prompt', () => {
    expect(
      toolUsesSinceLastPrompt([prompt('a'), assistant('Edit'), prompt()]),
    ).toBeNull();
  });

  it('does not stop at a meta user record', () => {
    const records = [prompt(), assistant('Write'), metaPrompt(), assistant()];
    expect(toolUsesSinceLastPrompt(records)).toEqual(['Write']);
  });

  it('walks past a task notification to the prompt that dispatched the agent', () => {
    const records = [
      prompt(),
      assistant('Agent'),
      toolResult(),
      assistant(),
      taskNotificationAt('2026-01-01T01:00:00.000Z'),
      assistant('Read'),
    ];
    expect(toolUsesSinceLastPrompt(records)).toEqual(['Agent', 'Read']);
  });

  it('walks past a compaction summary to the prompt that opened the turn', () => {
    const records = [
      prompt(),
      assistant('Edit'),
      compactSummary(),
      assistant(),
    ];
    expect(toolUsesSinceLastPrompt(records)).toEqual(['Edit']);
  });

  it('treats a user record of text blocks without a tool_result as the prompt', () => {
    const records: TurnRecord[] = [
      assistant('Edit'),
      { type: 'user', message: { content: [{ type: 'text', text: 'hi' }] } },
      assistant('Read'),
    ];
    expect(toolUsesSinceLastPrompt(records)).toEqual(['Read']);
  });

  it('ignores records that are neither user nor assistant', () => {
    const records: TurnRecord[] = [
      prompt(),
      { type: 'attachment' },
      assistant('Glob'),
      { type: 'api-request' },
      { type: 'last-prompt' },
    ];
    expect(toolUsesSinceLastPrompt(records)).toEqual(['Glob']);
  });
});

const RECORDED_REJECTED_EDIT_SESSION: string[] = [
  '{"type":"user","message":{"role":"user","content":"change the greeting"},"timestamp":"2026-11-24T13:47:40.000Z"}',
  '{"type":"api-request-blob","message":{"content":[{"type":"text","text":"system"}]}}',
  '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_01Ghv8GnnvxxjAVVZpjPAKrC","name":"Read","input":{}}]}}',
  '{"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_01Ghv8GnnvxxjAVVZpjPAKrC","type":"tool_result","content":"1\\texport"}]},"permissionDecision":{"decision":"accept","source":"config","reasonType":"mode"}}',
  '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_01CrJtVFkJRv3ViRZzjHredK","name":"Edit","input":{}}]}}',
  '{"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_01CrJtVFkJRv3ViRZzjHredK","type":"tool_result","content":"denied","is_error":true}]},"permissionDecision":{"decision":"reject","source":"config","reasonType":"rule"},"toolDenialKind":"permission-rule"}',
  '{"type":"api-request-blob","message":{"content":[{"type":"tool_use","id":"toolu_01CrJtVFkJRv3ViRZzjHredK","name":"Edit"}]}}',
  '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"The edit was denied."}]}}',
];

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function transcript(records: (TurnRecord | string)[]): string {
  dir = mkdtempSync(join(tmpdir(), 'transcript-turn-'));
  const path = join(dir, 'session.jsonl');
  const lines = records.map((r) =>
    typeof r === 'string' ? r : JSON.stringify(r),
  );
  writeFileSync(path, lines.join('\n') + '\n');
  return path;
}

describe('turnTouchedFiles', () => {
  it('is undefined with no transcript path', () => {
    expect(turnTouchedFiles(undefined)).toBeUndefined();
    expect(turnTouchedFiles('')).toBeUndefined();
  });

  it('is undefined for an unreadable transcript', () => {
    expect(
      turnTouchedFiles(join(tmpdir(), 'transcript-turn-missing', 'x.jsonl')),
    ).toBeUndefined();
  });

  it('is undefined when the transcript has no assistant record since the prompt', () => {
    expect(
      turnTouchedFiles(transcript([assistant('Edit'), prompt()])),
    ).toBeUndefined();
  });

  it('is false for a turn whose tool uses are all read-only', () => {
    const path = transcript([
      prompt('a'),
      assistant('Edit'),
      toolResult(),
      prompt(),
      assistant('Read', 'Grep'),
      toolResult(),
      toolResult(),
      assistant(),
    ]);
    expect(turnTouchedFiles(path)).toBe(false);
  });

  it('is false for a turn with no tool uses at all', () => {
    expect(turnTouchedFiles(transcript([prompt(), assistant()]))).toBe(false);
  });

  it.each(['Edit', 'Write', 'NotebookEdit', 'Bash'])(
    'is true for a turn with one %s tool use',
    (tool) => {
      const path = transcript([
        prompt(),
        assistant('Read'),
        toolResult(),
        assistant(tool),
        toolResult(),
        assistant(),
      ]);
      expect(turnTouchedFiles(path)).toBe(true);
    },
  );

  it('is true for a tool it does not know, so an unknown tool fails safe', () => {
    expect(READ_ONLY_TOOLS.has('mcp__ide__executeCode')).toBe(false);
    const path = transcript([prompt(), assistant('mcp__ide__executeCode')]);
    expect(turnTouchedFiles(path)).toBe(true);
  });

  it('skips malformed lines instead of failing', () => {
    const path = transcript([
      prompt(),
      assistant('Read'),
      '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Edit"',
      assistant(),
    ]);
    expect(turnTouchedFiles(path)).toBe(false);
  });
});

function toolUseRecord(id: string, name: string): TurnRecord {
  return {
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id, name, input: {} }] },
  };
}

function toolResultRecord(id: string, decision?: string): TurnRecord {
  return {
    type: 'user',
    ...(decision ? { permissionDecision: { decision } } : {}),
    message: {
      content: [{ type: 'tool_result', tool_use_id: id, content: 'x' }],
    },
  };
}

function userRejectedResultRecord(id: string): TurnRecord {
  return {
    type: 'user',
    toolDenialKind: 'user-rejected',
    toolUseResult: 'User rejected tool use',
    message: {
      content: [
        {
          type: 'tool_result',
          content: "The user doesn't want to proceed with this tool use.",
          is_error: true,
          tool_use_id: id,
        },
      ],
    },
  } as TurnRecord;
}

function blobNoise(id: string, name: string): TurnRecord {
  return {
    type: 'api-request-blob',
    message: { content: [{ type: 'tool_use', id, name }] },
  };
}

describe('toolUsesSinceLastPrompt with permission decisions', () => {
  it('counts every writing use whose result was accepted', () => {
    const records = [
      prompt(),
      toolUseRecord('a', 'Edit'),
      toolResultRecord('a', 'accept'),
      toolUseRecord('b', 'Write'),
      toolResultRecord('b', 'accept'),
    ];
    expect(toolUsesSinceLastPrompt(records)).toEqual(['Edit', 'Write']);
  });

  it('returns only the read-only uses when every writing use was rejected', () => {
    const records = [
      prompt(),
      toolUseRecord('a', 'Edit'),
      toolResultRecord('a', 'reject'),
      toolUseRecord('b', 'Read'),
      toolResultRecord('b', 'accept'),
      toolUseRecord('c', 'Bash'),
      toolResultRecord('c', 'reject'),
    ];
    expect(toolUsesSinceLastPrompt(records)).toEqual(['Read']);
  });

  it('omits the rejected Edit and keeps the accepted one in a mixed turn', () => {
    const records = [
      prompt(),
      toolUseRecord('a', 'Edit'),
      toolResultRecord('a', 'accept'),
      toolUseRecord('b', 'Edit'),
      toolResultRecord('b', 'reject'),
    ];
    expect(toolUsesSinceLastPrompt(records)).toEqual(['Edit']);
  });

  it('rejects every tool use named by one result record with several blocks', () => {
    const records: TurnRecord[] = [
      prompt(),
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 'a', name: 'Edit' },
            { type: 'tool_use', id: 'b', name: 'Write' },
          ],
        },
      },
      {
        type: 'user',
        permissionDecision: { decision: 'reject' },
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'a' },
            { type: 'tool_result', tool_use_id: 'b' },
          ],
        },
      },
    ];
    expect(toolUsesSinceLastPrompt(records)).toEqual([]);
  });
});

describe('toolUsesSinceLastPrompt with a toolDenialKind rejection', () => {
  it('omits the user-rejected Edit and keeps the accepted one', () => {
    const records = [
      prompt(),
      toolUseRecord('a', 'Edit'),
      toolResultRecord('a', 'accept'),
      toolUseRecord('b', 'Edit'),
      userRejectedResultRecord('b'),
    ];
    expect(toolUsesSinceLastPrompt(records)).toEqual(['Edit']);
  });
});

describe('turnTouchedFiles with a toolDenialKind rejection', () => {
  it('is false when the only writing use was user-rejected', () => {
    const path = transcript([
      prompt(),
      toolUseRecord('a', 'Edit'),
      userRejectedResultRecord('a'),
    ]);
    expect(turnTouchedFiles(path)).toBe(false);
  });

  it('is true when one Edit was kept and another was user-rejected', () => {
    const path = transcript([
      prompt(),
      toolUseRecord('a', 'Edit'),
      toolResultRecord('a'),
      toolUseRecord('b', 'Edit'),
      userRejectedResultRecord('b'),
    ]);
    expect(turnTouchedFiles(path)).toBe(true);
  });
});

describe('turnTouchedFiles with permission decisions', () => {
  it('is false when every writing use was rejected', () => {
    const path = transcript([
      prompt(),
      toolUseRecord('a', 'Edit'),
      toolResultRecord('a', 'reject'),
      toolUseRecord('b', 'Read'),
      toolResultRecord('b', 'accept'),
    ]);
    expect(turnTouchedFiles(path)).toBe(false);
  });

  it('is true when one Edit was accepted and another rejected', () => {
    const path = transcript([
      prompt(),
      toolUseRecord('a', 'Edit'),
      toolResultRecord('a', 'accept'),
      toolUseRecord('b', 'Edit'),
      toolResultRecord('b', 'reject'),
    ]);
    expect(turnTouchedFiles(path)).toBe(true);
  });

  it('counts a rejected Edit followed by an accepted retry of the same file as touched', () => {
    const path = transcript([
      prompt(),
      toolUseRecord('first', 'Edit'),
      toolResultRecord('first', 'reject'),
      toolUseRecord('retry', 'Edit'),
      toolResultRecord('retry', 'accept'),
      assistant(),
    ]);
    expect(turnTouchedFiles(path)).toBe(true);
  });

  it('counts a writing use as written when no record carries a permission decision', () => {
    const path = transcript([
      prompt(),
      toolUseRecord('a', 'Edit'),
      toolResultRecord('a'),
      assistant(),
    ]);
    expect(turnTouchedFiles(path)).toBe(true);
  });

  it('counts a writing use as written when the decision is not reject', () => {
    const path = transcript([
      prompt(),
      toolUseRecord('a', 'Write'),
      toolResultRecord('a', 'ask'),
    ]);
    expect(turnTouchedFiles(path)).toBe(true);
  });

  it('is false for a long turn whose writing uses were all rejected among noise records', () => {
    const records: TurnRecord[] = [
      prompt('earlier'),
      toolUseRecord('old', 'Edit'),
      toolResultRecord('old', 'accept'),
      prompt(),
    ];
    const WRITING_TOOL_NAMES = ['Edit', 'Write'];
    for (let i = 0; i < 6; i++) {
      records.push(
        toolUseRecord(`r${i}`, 'Read'),
        toolResultRecord(`r${i}`, 'accept'),
      );
      records.push(blobNoise(`r${i}`, 'Read'), { type: 'attachment' });
      records.push(
        toolUseRecord(
          `w${i}`,
          WRITING_TOOL_NAMES[i % WRITING_TOOL_NAMES.length]!,
        ),
        toolResultRecord(`w${i}`, 'reject'),
      );
      records.push(blobNoise(`w${i}`, 'Edit'));
    }
    records.push(assistant());
    expect(toolUsesSinceLastPrompt(records)).toEqual([
      'Read',
      'Read',
      'Read',
      'Read',
      'Read',
      'Read',
    ]);
    expect(turnTouchedFiles(transcript(records))).toBe(false);
  });

  it('is true for a long turn where one of many writing uses was accepted', () => {
    const records: TurnRecord[] = [prompt()];
    const ACCEPTED_WRITE_INDEX = 7;
    for (let i = 0; i < 12; i++) {
      records.push(
        toolUseRecord(`w${i}`, 'Edit'),
        toolResultRecord(
          `w${i}`,
          i === ACCEPTED_WRITE_INDEX ? 'accept' : 'reject',
        ),
      );
      records.push(blobNoise(`w${i}`, 'Edit'));
    }
    expect(toolUsesSinceLastPrompt(records)).toEqual(['Edit']);
    expect(turnTouchedFiles(transcript(records))).toBe(true);
  });

  it('is false for the recorded session whose only write was rejected', () => {
    const path = transcript(RECORDED_REJECTED_EDIT_SESSION);
    expect(turnTouchedFiles(path)).toBe(false);
  });
});

describe('turnStartedAt', () => {
  it('is the last human prompt’s timestamp in epoch milliseconds', () => {
    const path = transcript([
      promptAt('2026-01-01T00:00:00.000Z'),
      assistant('Edit'),
      toolResult(),
      promptAt('2026-01-01T01:00:00.000Z'),
      assistant('Read'),
    ]);
    expect(turnStartedAt(path)).toBe(1767229200000);
  });

  it('is the dispatching prompt’s timestamp after a task notification', () => {
    const path = transcript([
      promptAt('2026-01-01T00:00:00.000Z'),
      assistant('Agent'),
      toolResult(),
      taskNotificationAt('2026-01-01T01:00:00.000Z'),
      assistant('Read'),
    ]);
    expect(turnStartedAt(path)).toBe(1767225600000);
  });

  it('is undefined with no transcript path', () => {
    expect(turnStartedAt(undefined)).toBeUndefined();
  });

  it('is undefined when the prompt carries no timestamp', () => {
    expect(turnStartedAt(transcript([prompt(), assistant()]))).toBeUndefined();
  });
});
