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
