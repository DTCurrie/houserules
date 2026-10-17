import { describe, expect, it } from 'vitest';

import {
  computeResidentContext,
  renderResidentContext,
} from '../resident-context.js';
import { emptyCorpus, ingestTranscript } from '../transcript-events.js';

function attachmentLine(sessionId: string, attachment: unknown): string {
  return JSON.stringify({
    type: 'user',
    sessionId,
    timestamp: '2026-10-01T10:00:00.000Z',
    attachment,
  });
}

function buildCorpus() {
  const corpus = emptyCorpus(['slug']);
  const a = 'sess-aaaaaaaa';
  ingestTranscript(
    corpus,
    `${a}.jsonl`,
    [
      attachmentLine(a, {
        type: 'prompt_snapshot',
        systemPrompt: ['part one', 'part two'],
      }),
      attachmentLine(a, {
        type: 'instructions',
        files: [
          { path: '/x/CLAUDE.md', type: 'Project', content: 'abcd' },
          { path: '/x/MEMORY.md', type: 'AutoMem', content: 'ef' },
        ],
      }),
      attachmentLine(a, {
        type: 'skill_listing',
        content: 'skills!!!!',
        skillCount: 3,
      }),
      attachmentLine(a, {
        type: 'agent_listing_delta',
        isInitial: true,
        addedLines: ['agent one'],
        addedTypes: ['reviewer'],
      }),
      attachmentLine(a, {
        type: 'output_style_instructions',
        style: { name: 'Terse', prompt: 'terse' },
      }),
    ].join('\n'),
  );
  const b = 'sess-bbbbbbbb';
  ingestTranscript(
    corpus,
    `${b}.jsonl`,
    [
      attachmentLine(b, {
        type: 'prompt_snapshot',
        systemPrompt: ['0123456789'],
      }),
      attachmentLine(b, {
        type: 'nested_memory',
        content: { content: 'aaaa' },
      }),
      attachmentLine(b, {
        type: 'nested_memory',
        content: { content: 'bbbbbb' },
      }),
    ].join('\n'),
  );
  ingestTranscript(
    corpus,
    'sess-cccccccc.jsonl',
    JSON.stringify({
      type: 'user',
      sessionId: 'sess-cccccccc',
      timestamp: '2026-10-01T10:00:00.000Z',
    }),
  );
  return corpus;
}

describe('computeResidentContext', () => {
  it('sums the five start-of-session fields and keeps nested loads separate', () => {
    const report = computeResidentContext(buildCorpus());

    expect(report.rows).toEqual([
      {
        session: 'sess-aaaaaaaa',
        recorded: true,
        systemPromptBytes: 16,
        instructionBytes: 6,
        skillListingBytes: 10,
        agentListingBytes: 9,
        outputStyleBytes: 5,
        residentBytes: 46,
        estimatedTokens: 12,
        nestedMemoryLoads: 0,
        nestedMemoryBytes: 0,
      },
      {
        session: 'sess-bbbbbbbb',
        recorded: true,
        systemPromptBytes: 10,
        instructionBytes: 0,
        skillListingBytes: 0,
        agentListingBytes: 0,
        outputStyleBytes: 0,
        residentBytes: 10,
        estimatedTokens: 3,
        nestedMemoryLoads: 2,
        nestedMemoryBytes: 10,
      },
      {
        session: 'sess-cccccccc',
        recorded: false,
        systemPromptBytes: 0,
        instructionBytes: 0,
        skillListingBytes: 0,
        agentListingBytes: 0,
        outputStyleBytes: 0,
        residentBytes: 0,
        estimatedTokens: 0,
        nestedMemoryLoads: 0,
        nestedMemoryBytes: 0,
      },
    ]);
    expect(report.recorded).toBe(2);
    expect(report.totalSessions).toBe(3);
  });

  it('takes medians over recorded rows only', () => {
    const report = computeResidentContext(buildCorpus());

    // Recorded totals are 46 and 10 bytes, 12 and 3 tokens. The zero row would pull both down.
    expect(report.medianResidentBytes).toBe(28);
    expect(report.medianEstimatedTokens).toBe(8);
  });
});

describe('renderResidentContext', () => {
  it('renders the table, the not-recorded row, the nested cell, and the medians line', () => {
    const text = renderResidentContext(
      computeResidentContext(buildCorpus()),
    ).join('\n');

    expect(text).toContain('-- resident context --');
    expect(text).toContain('recorded 2 of 3 session(s)');
    expect(text).toContain('not recorded (no session-start attachments)');
    expect(text).toContain('2 (10)');
    expect(text).toContain('medians (all sessions): total 28 bytes, ~tokens 8');
    expect(text).toContain('Nested CLAUDE.md files load on demand');
  });

  it('renders a single line when no session recorded its attachments', () => {
    const corpus = emptyCorpus(['slug']);
    ingestTranscript(corpus, 'sess-cccccccc.jsonl', '{"type":"user"}');

    const lines = renderResidentContext(computeResidentContext(corpus));

    expect(lines).toContain(
      'no session recorded its session-start attachments',
    );
    expect(lines.join('\n')).not.toContain('medians');
  });
});

describe('entrypoint medians', () => {
  function entrypointCorpus() {
    const corpus = emptyCorpus(['slug']);
    const sessions: [string, string, string][] = [
      ['sess-cli00000', 'cli', 'x'.repeat(100)],
      ['sess-sdk00000', 'sdk-cli', 'x'.repeat(300)],
    ];
    for (const [id, entrypoint, prompt] of sessions) {
      ingestTranscript(
        corpus,
        `${id}.jsonl`,
        JSON.stringify({
          type: 'user',
          sessionId: id,
          entrypoint,
          timestamp: '2026-10-01T10:00:00.000Z',
          attachment: { type: 'prompt_snapshot', systemPrompt: [prompt] },
        }),
      );
    }
    return corpus;
  }

  it('reports one median per entrypoint and prints the column', () => {
    const report = computeResidentContext(entrypointCorpus());

    expect(report.medianByEntrypoint).toEqual([
      {
        entrypoint: 'cli',
        sessions: 1,
        medianResidentBytes: 100,
        medianEstimatedTokens: 25,
      },
      {
        entrypoint: 'sdk-cli',
        sessions: 1,
        medianResidentBytes: 300,
        medianEstimatedTokens: 75,
      },
    ]);
    expect(report.medianResidentBytes).toBe(200);
    const text = renderResidentContext(report).join('\n');
    expect(text).toContain('entrypoint');
    expect(text).toContain('medians (cli, 1 session(s)): total 100 bytes');
    expect(text).toContain('medians (sdk-cli, 1 session(s)): total 300 bytes');
  });

  it('renders rows from an older export and groups them as unknown', () => {
    const current = computeResidentContext(entrypointCorpus());
    const older = {
      ...current,
      rows: current.rows.map(({ entrypoint: _drop, ...rest }) => rest),
      medianByEntrypoint: undefined,
    };

    const text = renderResidentContext(older).join('\n');

    expect(text).toContain('medians (unknown, 2 session(s)): total 200 bytes');
  });
});
