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
