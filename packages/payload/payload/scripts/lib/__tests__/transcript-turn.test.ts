import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  READ_ONLY_TOOLS,
  toolUsesSinceLastPrompt,
  turnTouchedFiles,
  type TurnRecord,
} from '../transcript-turn.mjs';

function prompt(text = 'do the thing'): TurnRecord {
  return { type: 'user', message: { content: text } };
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

describe('turnTouchedFiles', () => {
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
