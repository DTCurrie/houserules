import { describe, expect, it } from 'vitest';
import { emptyCorpus, ingestTranscript } from '../transcript-events.js';
import { computeFriction, renderFriction } from '../friction.js';
import type { FrictionReport } from '../friction.js';

function corpusFrom(text: string, file = 'session.jsonl') {
  const corpus = emptyCorpus(['slug']);
  ingestTranscript(corpus, file, text);
  return corpus;
}

describe('computeFriction', () => {
  it('records a session that resumed from an auto-compact hook fire', () => {
    const corpus = corpusFrom(
      JSON.stringify({
        type: 'attachment',
        sessionId: 'compactsession01',
        attachment: { hookName: 'SessionStart:compact' },
      }),
    );

    const report = computeFriction(corpus);

    expect(report.compactedSessions).toEqual(['compacts']);
  });

  it('aggregates tool_result bulk under the resolved tool name', () => {
    const corpus = corpusFrom(
      [
        JSON.stringify({
          type: 'assistant',
          sessionId: 'bulk-session',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'tu-1',
                name: 'Bash',
                input: { command: 'echo hi' },
              },
            ],
          },
        }),
        JSON.stringify({
          type: 'user',
          sessionId: 'bulk-session',
          message: {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'tu-1', content: 'hello' },
            ],
          },
        }),
      ].join('\n'),
    );

    const report = computeFriction(corpus);

    expect(report.bulkByTool).toEqual([{ tool: 'Bash', results: 1, bytes: 7 }]);
  });

  it('buckets an unmatched tool_result under (unmatched)', () => {
    const corpus = corpusFrom(
      JSON.stringify({
        type: 'user',
        sessionId: 'unmatched-session',
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'missing-id', content: 'x' },
          ],
        },
      }),
    );

    const report = computeFriction(corpus);

    expect(report.bulkByTool).toEqual([
      { tool: '(unmatched)', results: 1, bytes: 3 },
    ]);
  });

  it('records a denial with the resolved tool and command', () => {
    const corpus = corpusFrom(
      [
        JSON.stringify({
          type: 'assistant',
          sessionId: 'denial-session',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'tu-2',
                name: 'Bash',
                input: { command: 'rm -rf /tmp/data' },
              },
            ],
          },
        }),
        JSON.stringify({
          type: 'user',
          sessionId: 'denial-session',
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'tu-2',
                content: "The user doesn't want to proceed with this tool use",
              },
            ],
          },
        }),
      ].join('\n'),
    );

    const report = computeFriction(corpus);

    expect(report.denials).toEqual([
      { tool: 'Bash', command: 'rm -rf /tmp/data' },
    ]);
  });

  it('counts an interrupt recorded on a tool_result', () => {
    const corpus = corpusFrom(
      [
        JSON.stringify({
          type: 'assistant',
          sessionId: 'interrupt-result-session',
          message: {
            role: 'assistant',
            content: [
              { type: 'tool_use', id: 'tu-3', name: 'Read', input: {} },
            ],
          },
        }),
        JSON.stringify({
          type: 'user',
          sessionId: 'interrupt-result-session',
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'tu-3',
                content: '[Request interrupted by user for tool use]',
              },
            ],
          },
        }),
      ].join('\n'),
    );

    const report = computeFriction(corpus);

    expect(report.interrupts).toBe(1);
    expect(report.denials).toEqual([]);
  });

  it('counts an interrupt recorded as a bare user text block', () => {
    const corpus = corpusFrom(
      JSON.stringify({
        type: 'user',
        sessionId: 'interrupt-text-session',
        message: {
          role: 'user',
          content: [{ type: 'text', text: '[Request interrupted by user]' }],
        },
      }),
    );

    const report = computeFriction(corpus);

    expect(report.interrupts).toBe(1);
  });

  it('groups a run of near-identical bash commands into one retry run', () => {
    const corpus = corpusFrom(
      JSON.stringify({
        type: 'assistant',
        sessionId: 'retry-session',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'tu-r1',
              name: 'Bash',
              input: { command: 'ls  -la' },
            },
            {
              type: 'tool_use',
              id: 'tu-r2',
              name: 'Bash',
              input: { command: 'ls -la' },
            },
            {
              type: 'tool_use',
              id: 'tu-r3',
              name: 'Bash',
              input: { command: 'ls -la ' },
            },
          ],
        },
      }),
    );

    const report = computeFriction(corpus);

    expect(report.retryRuns).toEqual([
      { session: 'retry-se', length: 3, command: 'ls -la' },
    ]);
  });

  it('records no run for two dissimilar bash commands', () => {
    const corpus = corpusFrom(
      JSON.stringify({
        type: 'assistant',
        sessionId: 'dissimilar-session',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'tu-d1',
              name: 'Bash',
              input: { command: 'echo foo' },
            },
            {
              type: 'tool_use',
              id: 'tu-d2',
              name: 'Bash',
              input: { command: 'rm -rf /var/lib/foo/bar/baz/qux' },
            },
          ],
        },
      }),
    );

    const report = computeFriction(corpus);

    expect(report.retryRuns).toEqual([]);
  });

  it('excludes sidechain bash from retries but includes it in bulk', () => {
    const corpus = corpusFrom(
      [
        JSON.stringify({
          type: 'assistant',
          sessionId: 'sidechain-session',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'tu-m1',
                name: 'Bash',
                input: { command: 'ls -la' },
              },
            ],
          },
        }),
        JSON.stringify({
          type: 'assistant',
          sessionId: 'sidechain-session',
          isSidechain: true,
          message: {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'tu-s1',
                name: 'Bash',
                input: { command: 'ls -la' },
              },
              {
                type: 'tool_use',
                id: 'tu-s2',
                name: 'Bash',
                input: { command: 'ls -la ' },
              },
            ],
          },
        }),
        JSON.stringify({
          type: 'user',
          sessionId: 'sidechain-session',
          message: {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'tu-s1', content: 'ok' },
            ],
          },
        }),
      ].join('\n'),
    );

    const report = computeFriction(corpus);

    expect(report.retryRuns).toEqual([]);
    expect(report.bulkByTool).toEqual([{ tool: 'Bash', results: 1, bytes: 4 }]);
  });

  it('skips a malformed line without throwing', () => {
    const corpus = corpusFrom(
      [
        '{not valid json',
        JSON.stringify({
          type: 'attachment',
          sessionId: 'malformed-session',
          attachment: { hookName: 'SessionStart:compact' },
        }),
      ].join('\n'),
    );

    const report = computeFriction(corpus);

    expect(report.compactedSessions).toEqual(['malforme']);
  });

  it('falls back to the file name as the session id when a record has no sessionId', () => {
    const corpus = corpusFrom(
      JSON.stringify({
        type: 'attachment',
        attachment: { hookName: 'SessionStart:compact' },
      }),
      'fallback-file.jsonl',
    );

    const report = computeFriction(corpus);

    expect(report.compactedSessions).toEqual(['fallback']);
  });
});

describe('renderFriction', () => {
  it('renders an empty report with zeroed summary lines', () => {
    const report: FrictionReport = {
      compactedSessions: [],
      bulkByTool: [],
      retryRuns: [],
      denials: [],
      interrupts: 0,
    };

    const lines = renderFriction(report);

    expect(lines).toEqual([
      '-- friction --',
      '',
      '  compaction: 0 session(s) resumed from auto-compact',
      '',
      '  tool_result bulk (top by bytes):',
      '  tool  results  bytes',
      '  ----  -------  -----',
      '',
      '  bash retries (main chain, adjacent commands >= 0.9 similar): 0 runs, 0 repeated calls',
      '',
      '  denials: 0 tool use(s) rejected by the user, 0 interrupted mid-call',
    ]);
  });

  it('renders a populated report with compaction, bulk, retries, and denials', () => {
    const report: FrictionReport = {
      compactedSessions: ['abcd1234'],
      bulkByTool: [{ tool: 'Bash', results: 1, bytes: 5 }],
      retryRuns: [{ session: 'abcd1234', length: 3, command: 'ls -la' }],
      denials: [{ tool: 'Bash', command: 'rm -rf /tmp/data' }],
      interrupts: 2,
    };

    const lines = renderFriction(report);

    expect(lines).toEqual([
      '-- friction --',
      '',
      '  compaction: 1 session(s) resumed from auto-compact (abcd1234)',
      '',
      '  tool_result bulk (top by bytes):',
      '  tool  results  bytes',
      '  ----  -------  -----',
      '  Bash  1        5    ',
      '',
      '  bash retries (main chain, adjacent commands >= 0.9 similar): 1 runs, 2 repeated calls',
      '    abcd1234  x3  ls -la',
      '',
      '  denials: 1 tool use(s) rejected by the user, 2 interrupted mid-call',
      '    Bash  rm -rf /tmp/data',
    ]);
  });
});
