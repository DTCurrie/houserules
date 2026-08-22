import { describe, expect, it } from 'vitest';
import { emptyCorpus, ingestTranscript } from '../transcript-events.js';
import { computeHookHealth, renderHookHealth } from '../hook-health.js';

function attachmentLine(fields: {
  hookName: string;
  exitCode?: number;
  stderr?: string;
  content?: string;
  durationMs?: number;
  sessionId?: string;
}): string {
  return JSON.stringify({
    type: 'attachment',
    sessionId: fields.sessionId,
    attachment: {
      hookName: fields.hookName,
      exitCode: fields.exitCode,
      stderr: fields.stderr,
      content: fields.content,
      durationMs: fields.durationMs,
    },
  });
}

function assistantBashLine(id: string, isSidechain: boolean): string {
  return JSON.stringify({
    type: 'assistant',
    sessionId: 'sess-1',
    isSidechain,
    message: {
      role: 'assistant',
      content: [
        { type: 'tool_use', id, name: 'Bash', input: { command: 'ls' } },
      ],
    },
  });
}

function assistantReadLine(id: string): string {
  return JSON.stringify({
    type: 'assistant',
    sessionId: 'sess-1',
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id, name: 'Read', input: {} }],
    },
  });
}

describe('computeHookHealth', () => {
  it('aggregates fires, nonZero, crashes, blocks, and durations per hook', () => {
    const corpus = emptyCorpus(['slug']);
    const lines = [
      attachmentLine({
        hookName: 'guard-bash',
        exitCode: 0,
        durationMs: 10,
        sessionId: 'sess-1',
      }),
      attachmentLine({
        hookName: 'guard-bash',
        durationMs: 20,
        sessionId: 'sess-1',
      }),
      attachmentLine({
        hookName: 'guard-bash',
        exitCode: 1,
        stderr:
          "Cannot find module '/x/y.mjs'\n    at Object.<anonymous> (/x/y.mjs:1:1)",
        durationMs: 30,
        sessionId: 'sess-1',
      }),
      attachmentLine({
        hookName: 'guard-bash',
        exitCode: 2,
        stderr: 'git commit is yours to run',
        sessionId: 'sess-1',
      }),
      attachmentLine({ hookName: 'other-hook', exitCode: 0 }),
      'not json',
    ];

    ingestTranscript(corpus, 'crashy-session.jsonl', lines.join('\n'));
    const report = computeHookHealth(corpus);

    const guardBash = report.rows.find((row) => row.hook === 'guard-bash');

    expect(guardBash).toEqual({
      hook: 'guard-bash',
      fires: 4,
      nonZero: 2,
      crashes: 1,
      blocks: 1,
      p50: 20,
      p95: 30,
      max: 30,
    });
  });

  it('sorts rows by fires descending', () => {
    const corpus = emptyCorpus(['slug']);
    const lines = [
      attachmentLine({
        hookName: 'guard-bash',
        exitCode: 0,
        sessionId: 'sess-1',
      }),
      attachmentLine({
        hookName: 'guard-bash',
        exitCode: 0,
        sessionId: 'sess-1',
      }),
      attachmentLine({
        hookName: 'guard-bash',
        exitCode: 0,
        sessionId: 'sess-1',
      }),
      attachmentLine({
        hookName: 'guard-bash',
        exitCode: 0,
        sessionId: 'sess-1',
      }),
      attachmentLine({
        hookName: 'other-hook',
        exitCode: 0,
        sessionId: 'sess-1',
      }),
    ];

    ingestTranscript(corpus, 'sorted.jsonl', lines.join('\n'));
    const report = computeHookHealth(corpus);

    expect(report.rows.map((row) => row.hook)).toEqual([
      'guard-bash',
      'other-hook',
    ]);
  });

  it('groups crash signatures and counts them descending', () => {
    const corpus = emptyCorpus(['slug']);
    const lines = [
      attachmentLine({
        hookName: 'guard-bash',
        exitCode: 1,
        stderr: "Cannot find module '/x/y.mjs'\n    at Object.<anonymous>",
        sessionId: 'sess-1',
      }),
      attachmentLine({
        hookName: 'guard-bash',
        exitCode: 1,
        stderr: "Cannot find module '/x/y.mjs'\n    at Object.<anonymous>",
        sessionId: 'sess-1',
      }),
      attachmentLine({
        hookName: 'guard-bash',
        exitCode: 1,
        stderr: "Cannot find module '/a/b.mjs'\n    at Object.<anonymous>",
        sessionId: 'sess-1',
      }),
    ];

    ingestTranscript(corpus, 'crashes.jsonl', lines.join('\n'));
    const report = computeHookHealth(corpus);

    expect(report.crashSignatures).toEqual([
      { signature: "Cannot find module '/x/y.mjs'", count: 2 },
      { signature: "Cannot find module '/a/b.mjs'", count: 1 },
    ]);
  });

  it('counts Bash tool calls across sessions, sidechain included', () => {
    const corpus = emptyCorpus(['slug']);
    const lines = [
      assistantBashLine('tool-1', false),
      assistantBashLine('tool-2', true),
      assistantReadLine('tool-3'),
    ];

    ingestTranscript(corpus, 'bash-calls.jsonl', lines.join('\n'));
    const report = computeHookHealth(corpus);

    expect(report.bashCalls).toBe(2);
  });
});

describe('renderHookHealth', () => {
  it('renders the header, table, scale note, and crash signatures', () => {
    const corpus = emptyCorpus(['slug']);
    const lines = [
      attachmentLine({
        hookName: 'guard-bash',
        exitCode: 0,
        durationMs: 10,
        sessionId: 'sess-1',
      }),
      attachmentLine({
        hookName: 'guard-bash',
        durationMs: 20,
        sessionId: 'sess-1',
      }),
      attachmentLine({
        hookName: 'guard-bash',
        exitCode: 1,
        stderr:
          "Cannot find module '/x/y.mjs'\n    at Object.<anonymous> (/x/y.mjs:1:1)",
        durationMs: 30,
        sessionId: 'sess-1',
      }),
      attachmentLine({
        hookName: 'guard-bash',
        exitCode: 2,
        stderr: 'git commit is yours to run',
        sessionId: 'sess-1',
      }),
      attachmentLine({
        hookName: 'other-hook',
        exitCode: 0,
        sessionId: 'sess-1',
      }),
      assistantBashLine('tool-1', false),
    ];

    ingestTranscript(corpus, 'render.jsonl', lines.join('\n'));
    const report = computeHookHealth(corpus);
    const rendered = renderHookHealth(report);

    expect(rendered).toEqual([
      '-- hook health --',
      '',
      '  hook        fires  non-zero  crashes  blocks  p50ms  p95ms  maxms',
      '  ----------  -----  --------  -------  ------  -----  -----  -----',
      '  guard-bash  4      2         1        1       20     30     30   ',
      '  other-hook  1      0         0        0       0      0      0    ',
      '',
      '  (fires counts recorded attachments, which exist only when a hook emitted output.',
      '   For scale: this corpus holds 1 Bash tool calls.)',
      '',
      '  crash signatures:',
      "       1  Cannot find module '/x/y.mjs'",
    ]);
  });

  it('omits the crash signatures section when there are none', () => {
    const corpus = emptyCorpus(['slug']);
    const lines = [
      attachmentLine({
        hookName: 'guard-bash',
        exitCode: 0,
        sessionId: 'sess-1',
      }),
    ];

    ingestTranscript(corpus, 'no-crashes.jsonl', lines.join('\n'));
    const report = computeHookHealth(corpus);
    const rendered = renderHookHealth(report);

    expect(rendered.at(-1)).toBe(
      '   For scale: this corpus holds 0 Bash tool calls.)',
    );
    expect(rendered.join('\n')).not.toContain('crash signatures');
  });
});
