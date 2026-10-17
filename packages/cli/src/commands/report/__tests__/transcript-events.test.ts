import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  emptyCorpus,
  ingestTranscript,
  readCorpus,
} from '../transcript-events.js';

function line(record: unknown): string {
  return JSON.stringify(record);
}

function stamped(timestamp: string, sessionId = 'sess-1'): string {
  return line({
    type: 'user',
    sessionId,
    timestamp,
    message: { role: 'user', content: 'hi' },
  });
}

function attachment(
  type: string,
  fields: Record<string, unknown>,
  sessionId = 'sess-1',
): string {
  return line({
    type: 'user',
    sessionId,
    timestamp: '2026-10-01T10:00:00.000Z',
    attachment: { type, ...fields },
  });
}

describe('readCorpus since filter', () => {
  let base: string;
  const since = Date.parse('2026-08-23');

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'corpus-'));
    mkdirSync(join(base, 'slug'));
  });

  function write(name: string, content: string): string {
    const path = join(base, 'slug', name);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, content);
    return path;
  }

  it('skips a file that starts before since, with its subagent transcripts', () => {
    write('old.jsonl', stamped('2026-08-01T00:00:00.000Z', 'old'));
    write(
      'old/subagents/agent-1.jsonl',
      stamped('2026-09-01T00:00:00.000Z', 'old'),
    );

    const corpus = readCorpus(base, ['slug'], { since });

    expect(corpus.files).toEqual([]);
    expect(corpus.sessions.size).toBe(0);
    expect(corpus.lines).toBe(0);
    expect(corpus.lastTs).toBeUndefined();
    expect(corpus.skippedBySince).toBe(1);
  });

  it('keeps a file that starts after since', () => {
    write('new.jsonl', stamped('2026-09-01T00:00:00.000Z', 'new'));

    const corpus = readCorpus(base, ['slug'], { since });

    expect(corpus.files.map((f) => f.file)).toEqual(['new.jsonl']);
    expect(corpus.lines).toBe(1);
    expect(corpus.skippedBySince).toBe(0);
  });

  it('judges a file by its first timestamped record, skipping unparseable and untimed lines', () => {
    write(
      'mixed.jsonl',
      `not json\n${line({ type: 'summary' })}\n${stamped('2026-08-01T00:00:00.000Z')}\n${stamped('2026-09-01T00:00:00.000Z')}\n`,
    );

    const corpus = readCorpus(base, ['slug'], { since });

    expect(corpus.files).toEqual([]);
  });

  it('skips a file with no timestamps when its mtime predates since', () => {
    const path = write('untimed.jsonl', line({ type: 'summary' }));
    const old = new Date('2026-08-01T00:00:00.000Z');
    utimesSync(path, old, old);

    const corpus = readCorpus(base, ['slug'], { since });

    expect(corpus.files).toEqual([]);
    expect(corpus.skippedBySince).toBe(1);
  });

  it('keeps a file with no timestamps when its mtime is recent', () => {
    write('untimed.jsonl', line({ type: 'summary' }));

    const corpus = readCorpus(base, ['slug'], { since });

    expect(corpus.files.map((f) => f.file)).toEqual(['untimed.jsonl']);
  });

  it('keeps every file when no since is given', () => {
    write('old.jsonl', stamped('2026-08-01T00:00:00.000Z', 'old'));
    write('new.jsonl', stamped('2026-09-01T00:00:00.000Z', 'new'));

    const corpus = readCorpus(base, ['slug']);

    expect(corpus.files.map((f) => f.file)).toEqual(['new.jsonl', 'old.jsonl']);
    expect(corpus.skippedBySince).toBe(0);
  });
});

describe('ingestTranscript resident captures', () => {
  it('sizes every session-start attachment once, keeping the first value seen', () => {
    const corpus = emptyCorpus(['slug']);

    ingestTranscript(
      corpus,
      'sess-1.jsonl',
      [
        attachment('prompt_snapshot', {
          systemPrompt: ['part one', 'pärt two'],
        }),
        attachment('prompt_snapshot', { systemPrompt: ['replayed'] }),
        attachment('instructions', {
          files: [
            { path: '/Users/x/CLAUDE.md', type: 'Project', content: 'abcd' },
            { path: '/Users/x/MEMORY.md', type: 'AutoMem', content: 'éé' },
          ],
        }),
        attachment('skill_listing', { content: 'twelve chars', skillCount: 3 }),
        attachment('agent_listing_delta', {
          isInitial: false,
          addedLines: ['late addition'],
          addedTypes: ['later'],
        }),
        attachment('agent_listing_delta', {
          isInitial: true,
          addedLines: ['one', 'two'],
          addedTypes: ['a', 'b'],
        }),
        attachment('output_style_instructions', {
          style: { name: 'Prose', prompt: 'be terse' },
        }),
      ].join('\n'),
    );

    expect(corpus.residentCaptures.get('sess-1')).toEqual({
      sessionId: 'sess-1',
      ts: Date.parse('2026-10-01T10:00:00.000Z'),
      systemPromptBytes: 17,
      instructionFiles: [
        { type: 'Project', bytes: 4 },
        { type: 'AutoMem', bytes: 4 },
      ],
      skillListingBytes: 12,
      skillCount: 3,
      agentListingBytes: 6,
      agentCount: 2,
      outputStyleBytes: 8,
      nestedMemoryLoads: 0,
      nestedMemoryBytes: 0,
      nestedMemoryByOrigin: {
        main: { loads: 0, bytes: 0 },
        subagent: { loads: 0, bytes: 0 },
      },
      nestedMemoryFiles: new Map(),
    });
  });

  it('accumulates every nested memory load', () => {
    const corpus = emptyCorpus(['slug']);

    ingestTranscript(
      corpus,
      'sess-1.jsonl',
      [
        attachment('nested_memory', {
          path: '/Users/x/packages/cli/CLAUDE.md',
          content: { path: '/Users/x/packages/cli/CLAUDE.md', content: 'abc' },
        }),
        attachment('nested_memory', { content: { content: 'defgh' } }),
      ].join('\n'),
    );

    const kept = corpus.residentCaptures.get('sess-1');
    expect(kept?.nestedMemoryLoads).toBe(2);
    expect(kept?.nestedMemoryBytes).toBe(8);
    expect([...(kept?.nestedMemoryFiles ?? [])]).toEqual([
      ['/Users/x/packages/cli/CLAUDE.md', { loads: 1, bytes: 3 }],
      ['(unnamed)', { loads: 1, bytes: 5 }],
    ]);
    expect(kept?.systemPromptBytes).toBeUndefined();
  });

  it('records 0 bytes when systemPrompt is not an array and no file paths anywhere', () => {
    const corpus = emptyCorpus(['slug']);

    ingestTranscript(
      corpus,
      'sess-1.jsonl',
      attachment('prompt_snapshot', { systemPrompt: 'a plain string' }),
    );

    const kept = corpus.residentCaptures.get('sess-1');
    expect(kept?.systemPromptBytes).toBe(0);
    expect(JSON.stringify(kept)).not.toContain('/');
  });
});

describe('ingestTranscript record stamps', () => {
  it('collects every distinct version stamp', () => {
    const corpus = emptyCorpus(['slug']);

    ingestTranscript(
      corpus,
      'sess-1.jsonl',
      [
        line({ type: 'user', version: '2.1.300' }),
        line({ type: 'user', version: '2.1.302' }),
        line({ type: 'user', version: '2.1.302' }),
      ].join('\n'),
    );

    expect([...corpus.claudeVersions].sort()).toEqual(['2.1.300', '2.1.302']);
  });

  it('tracks the min and max timestamps regardless of record order', () => {
    const corpus = emptyCorpus(['slug']);

    ingestTranscript(
      corpus,
      'sess-1.jsonl',
      [
        stamped('2026-09-05T00:00:00.000Z'),
        stamped('2026-09-01T00:00:00.000Z'),
        stamped('2026-09-09T00:00:00.000Z'),
      ].join('\n'),
    );

    expect(corpus.firstTs).toBe(Date.parse('2026-09-01T00:00:00.000Z'));
    expect(corpus.lastTs).toBe(Date.parse('2026-09-09T00:00:00.000Z'));
  });
});

describe('ingestTranscript entrypoint', () => {
  it('records the entrypoint carried by the session-start records', () => {
    const corpus = emptyCorpus(['slug']);
    const line = JSON.stringify({
      type: 'user',
      sessionId: 'sess-sdk',
      timestamp: '2026-10-01T10:00:00.000Z',
      entrypoint: 'sdk-cli',
      attachment: { type: 'prompt_snapshot', systemPrompt: ['abc'] },
    });

    ingestTranscript(corpus, 'sess-sdk.jsonl', line);

    expect(corpus.residentCaptures.get('sess-sdk')?.entrypoint).toBe('sdk-cli');
  });
});

describe('ingestTranscript per-session usage', () => {
  function turn(
    timestamp: string,
    model: string | undefined,
    usage: [number, number, number, number],
  ): string {
    return line({
      type: 'assistant',
      sessionId: 'sess-1',
      timestamp,
      message: {
        role: 'assistant',
        model,
        usage: {
          input_tokens: usage[0],
          output_tokens: usage[1],
          cache_read_input_tokens: usage[2],
          cache_creation_input_tokens: usage[3],
        },
      },
    });
  }

  function ingestPair() {
    const corpus = emptyCorpus(['slug']);
    ingestTranscript(
      corpus,
      'sess-1.jsonl',
      [
        turn('2026-10-01T10:00:00Z', 'model-a', [10, 20, 100, 5]),
        turn('2026-10-01T10:01:00Z', 'model-a', [1, 2, 3, 4]),
      ].join('\n'),
    );
    const row = corpus.files[0]!;
    ingestTranscript(
      corpus,
      'agent-1.jsonl',
      [
        turn('2026-10-01T10:05:00Z', 'model-b', [7, 8, 9, 10]),
        turn('2026-10-01T10:04:00Z', undefined, [2, 3, 0, 1]),
      ].join('\n'),
      row,
    );
    return row;
  }

  it('splits tokens by origin, by model, and spans the folded timestamps', () => {
    const row = ingestPair();

    expect(row.byOrigin.main).toEqual({
      turns: 2,
      input: 11,
      output: 22,
      cacheRead: 103,
      cacheWrite: 9,
    });
    expect(row.byOrigin.subagent).toEqual({
      turns: 2,
      input: 9,
      output: 11,
      cacheRead: 9,
      cacheWrite: 11,
    });
    expect(row.byModel.get('model-a')).toEqual({
      turns: 2,
      input: 11,
      output: 22,
      cacheRead: 103,
      cacheWrite: 9,
    });
    // The model-less subagent turn counts toward its origin but opens no model slice.
    expect(row.byModel.get('model-b')).toEqual({
      turns: 1,
      input: 7,
      output: 8,
      cacheRead: 9,
      cacheWrite: 10,
    });
    expect(row.byModel.size).toBe(2);
    expect(row.firstTs).toBe(Date.parse('2026-10-01T10:00:00Z'));
    expect(row.lastTs).toBe(Date.parse('2026-10-01T10:05:00Z'));
  });

  it('keeps the row totals equal to the sum of both origins', () => {
    const row = ingestPair();

    expect(row.turns).toBe(4);
    expect(row.input).toBe(20);
    expect(row.output).toBe(33);
    expect(row.cacheRead).toBe(112);
    expect(row.cacheWrite).toBe(20);
  });
});

describe('readCorpus per-session usage origin', () => {
  it('files the main transcript under main and the subagent transcript under subagent', () => {
    const base = mkdtempSync(join(tmpdir(), 'corpus-origin-'));
    mkdirSync(join(base, 'slug', 'sess-1', 'subagents'), { recursive: true });
    const turn = (input: number, output: number, model: string) =>
      line({
        type: 'assistant',
        sessionId: 'sess-1',
        timestamp: '2026-10-01T10:00:00Z',
        message: {
          role: 'assistant',
          model,
          usage: {
            input_tokens: input,
            output_tokens: output,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        },
      });
    writeFileSync(join(base, 'slug', 'sess-1.jsonl'), turn(5, 6, 'model-a'));
    writeFileSync(
      join(base, 'slug', 'sess-1', 'subagents', 'agent-x.jsonl'),
      turn(30, 40, 'model-b'),
    );

    const corpus = readCorpus(base, ['slug']);
    const row = corpus.files[0]!;

    expect(row.byOrigin.main).toEqual({
      turns: 1,
      input: 5,
      output: 6,
      cacheRead: 0,
      cacheWrite: 0,
    });
    expect(row.byOrigin.subagent).toEqual({
      turns: 1,
      input: 30,
      output: 40,
      cacheRead: 0,
      cacheWrite: 0,
    });
  });
});
