import { describe, expect, it } from 'vitest';

import { emptyCorpus, ingestTranscript } from '../transcript-events.js';
import { computeTokenUsage, renderTokenUsage } from '../token-usage.js';

function line(record: unknown): string {
  return JSON.stringify(record);
}

describe('computeTokenUsage', () => {
  it('sums input, output, and cache tokens from a type-keyed assistant record', () => {
    const corpus = emptyCorpus(['slug']);
    ingestTranscript(
      corpus,
      'sess-abcdef12.jsonl',
      line({
        type: 'assistant',
        message: {
          role: 'assistant',
          model: 'claude-3-opus',
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            cache_read_input_tokens: 20,
            cache_creation_input_tokens: 10,
          },
        },
      }),
    );

    const report = computeTokenUsage(corpus);

    expect(report.totals).toEqual({
      turns: 1,
      input: 100,
      output: 50,
      cacheRead: 20,
      cacheWrite: 10,
      toolResults: 0,
      models: ['claude-3-opus'],
      sidechainTurns: 0,
      skippedLines: 0,
    });
  });

  it('counts a turn from an assistant record keyed only by message.role', () => {
    const corpus = emptyCorpus(['slug']);
    ingestTranscript(
      corpus,
      'sess-abcdef12.jsonl',
      line({
        message: {
          role: 'assistant',
          model: 'claude-3-haiku',
          usage: { input_tokens: 5, output_tokens: 2 },
        },
      }),
    );

    const report = computeTokenUsage(corpus);

    expect(report.totals.turns).toBe(1);
    expect(report.totals.models).toEqual(['claude-3-haiku']);
  });

  it('defaults missing usage fields to zero', () => {
    const corpus = emptyCorpus(['slug']);
    ingestTranscript(
      corpus,
      'sess-abcdef12.jsonl',
      line({
        type: 'assistant',
        message: { role: 'assistant', model: 'claude-3-sonnet' },
      }),
    );

    const report = computeTokenUsage(corpus);

    expect(report.totals).toEqual({
      turns: 1,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      toolResults: 0,
      models: ['claude-3-sonnet'],
      sidechainTurns: 0,
      skippedLines: 0,
    });
  });

  it('counts tool_result blocks in array user content', () => {
    const corpus = emptyCorpus(['slug']);
    ingestTranscript(
      corpus,
      'sess-abcdef12.jsonl',
      line({
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', content: 'ok' },
            { type: 'tool_result', content: 'ok2' },
            { type: 'text', text: 'not a tool result' },
          ],
        },
      }),
    );

    const report = computeTokenUsage(corpus);

    expect(report.totals.toolResults).toBe(2);
  });

  it('does not count tool results from plain string user content', () => {
    const corpus = emptyCorpus(['slug']);
    ingestTranscript(
      corpus,
      'sess-abcdef12.jsonl',
      line({
        type: 'user',
        message: { role: 'user', content: 'plain text reply' },
      }),
    );

    const report = computeTokenUsage(corpus);

    expect(report.totals.toolResults).toBe(0);
  });

  it('counts a malformed line as skipped without throwing', () => {
    const corpus = emptyCorpus(['slug']);
    ingestTranscript(corpus, 'sess-abcdef12.jsonl', 'not json at all');

    const report = computeTokenUsage(corpus);

    expect(report.totals.skippedLines).toBe(1);
  });

  it('counts a sidechain assistant turn separately from turns', () => {
    const corpus = emptyCorpus(['slug']);
    ingestTranscript(
      corpus,
      'sess-abcdef12.jsonl',
      [
        line({
          type: 'assistant',
          isSidechain: true,
          message: { role: 'assistant', usage: { input_tokens: 1 } },
        }),
        line({
          type: 'assistant',
          message: { role: 'assistant', usage: { input_tokens: 1 } },
        }),
      ].join('\n'),
    );

    const report = computeTokenUsage(corpus);

    expect(report.totals.turns).toBe(2);
    expect(report.totals.sidechainTurns).toBe(1);
  });

  it('collects model names across files in first-seen order', () => {
    const corpus = emptyCorpus(['slug']);
    ingestTranscript(
      corpus,
      'sess-first111.jsonl',
      line({
        type: 'assistant',
        message: { role: 'assistant', model: 'model-b' },
      }),
    );
    ingestTranscript(
      corpus,
      'sess-second22.jsonl',
      [
        line({
          type: 'assistant',
          message: { role: 'assistant', model: 'model-a' },
        }),
        line({
          type: 'assistant',
          message: { role: 'assistant', model: 'model-b' },
        }),
      ].join('\n'),
    );

    const report = computeTokenUsage(corpus);

    expect(report.totals.models).toEqual(['model-b', 'model-a']);
  });

  it('carries the corpus unreadable file count into the report', () => {
    const corpus = emptyCorpus(['slug']);
    corpus.unreadableFiles.push({
      file: 'bad.jsonl',
      message: 'permission denied',
    });

    const report = computeTokenUsage(corpus);

    expect(report.unreadableFileCount).toBe(1);
  });
});

describe('renderTokenUsage', () => {
  it('renders the per-file line with the same fields and weighted-in as report.ts', () => {
    const corpus = emptyCorpus(['slug']);
    ingestTranscript(
      corpus,
      'sess-abcdef12.jsonl',
      [
        line({
          type: 'assistant',
          message: {
            role: 'assistant',
            model: 'claude-3-opus',
            usage: {
              input_tokens: 200,
              output_tokens: 40,
              cache_read_input_tokens: 30,
              cache_creation_input_tokens: 8,
            },
          },
        }),
        line({
          type: 'user',
          message: {
            role: 'user',
            content: [
              { type: 'tool_result', content: 'a' },
              { type: 'tool_result', content: 'b' },
            ],
          },
        }),
      ].join('\n'),
    );

    const rendered = renderTokenUsage(computeTokenUsage(corpus));

    expect(rendered[0]).toBe('1 session(s):');
    expect(rendered[1]).toBe('');
    expect(rendered[2]).toBe(
      '  sess-abc  turns 1  in 200  out 40  cache_read 30  cache_write 8  tools 2  weighted-in 213',
    );
  });

  it('appends the skipped-lines suffix only when a file had skipped lines', () => {
    const corpus = emptyCorpus(['slug']);
    ingestTranscript(
      corpus,
      'sess-abcdef12.jsonl',
      [
        line({
          type: 'assistant',
          message: { role: 'assistant', usage: { input_tokens: 1 } },
        }),
        'not json at all',
      ].join('\n'),
    );

    const rendered = renderTokenUsage(computeTokenUsage(corpus));

    expect(rendered[2]).toBe(
      '  sess-abc  turns 1  in 1  out 0  cache_read 0  cache_write 0  tools 0  weighted-in 1  (1 line(s) could not be parsed and were skipped)',
    );
  });

  it('renders the totals block with cache-read share and cost-weighted totals', () => {
    const corpus = emptyCorpus(['slug']);
    ingestTranscript(
      corpus,
      'sess-abcdef12.jsonl',
      [
        line({
          type: 'assistant',
          message: {
            role: 'assistant',
            model: 'claude-3-opus',
            usage: {
              input_tokens: 200,
              output_tokens: 40,
              cache_read_input_tokens: 30,
              cache_creation_input_tokens: 8,
            },
          },
        }),
        line({
          type: 'user',
          message: {
            role: 'user',
            content: [
              { type: 'tool_result', content: 'a' },
              { type: 'tool_result', content: 'b' },
            ],
          },
        }),
      ].join('\n'),
    );

    const rendered = renderTokenUsage(computeTokenUsage(corpus));

    expect(rendered.slice(3)).toEqual([
      '',
      '-- totals --',
      '  turns 1 | fresh input 200 | output 40',
      '  cache_read 30 | cache_write 8 | tool_results 2',
      '  cache-read share of input: 13% (cheap tier — the higher the better)',
      '  cost-weighted input-equivalent: 213 (cache_read ×0.1, cache_write ×1.25)',
      '  models: claude-3-opus | sidechain turns: 0%',
      '',
      '(cache_read is cost-weighted, never summed flat with fresh input; native /usage covers the live view.)',
    ]);
  });

  it('appends the exclusion note only when files were unreadable or lines were skipped', () => {
    const corpus = emptyCorpus(['slug']);
    corpus.unreadableFiles.push({
      file: 'bad.jsonl',
      message: 'permission denied',
    });
    ingestTranscript(corpus, 'sess-abcdef12.jsonl', 'not json at all');

    const rendered = renderTokenUsage(computeTokenUsage(corpus));

    expect(rendered[rendered.length - 1]).toBe(
      '(1 session file(s) and 1 line(s) across the rest could not be parsed and were excluded from the totals above.)',
    );
  });

  it('omits the exclusion note when nothing was skipped or unreadable', () => {
    const corpus = emptyCorpus(['slug']);
    ingestTranscript(
      corpus,
      'sess-abcdef12.jsonl',
      line({
        type: 'assistant',
        message: { role: 'assistant', usage: { input_tokens: 1 } },
      }),
    );

    const rendered = renderTokenUsage(computeTokenUsage(corpus));

    expect(rendered[rendered.length - 1]).toBe(
      '(cache_read is cost-weighted, never summed flat with fresh input; native /usage covers the live view.)',
    );
  });
});
