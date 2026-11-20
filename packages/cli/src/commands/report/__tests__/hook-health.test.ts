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

  it('classifies a missing payload-script exit as a crash, not a block', () => {
    const corpus = emptyCorpus(['slug']);
    const lines = [
      attachmentLine({
        hookName: 'Stop',
        exitCode: 1,
        stderr:
          '[houserules] lint-format-fix.mjs missing. Run: npx houserules update',
        sessionId: 'sess-1',
      }),
      attachmentLine({
        hookName: 'Stop',
        exitCode: 1,
        stderr:
          '[houserules] lint-format-fix.mjs missing. Run: npx houserules update',
        sessionId: 'sess-1',
      }),
    ];

    ingestTranscript(corpus, 'missing-script.jsonl', lines.join('\n'));
    const report = computeHookHealth(corpus);

    const stop = report.rows.find((row) => row.hook === 'Stop');
    expect(stop).toMatchObject({ nonZero: 2, crashes: 2, blocks: 0 });
    expect(report.crashSignatures).toEqual([
      { signature: 'missing script: lint-format-fix.mjs', count: 2 },
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
      '',
      '  Stop hooks: no Stop runs were recorded.',
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

    expect(rendered.at(-1)).toBe('  Stop hooks: no Stop runs were recorded.');
    expect(rendered.join('\n')).not.toContain('crash signatures');
  });
});

describe('computeHookHealth from error tool_results', () => {
  const wrapper =
    '[ -f x ] || { echo "[houserules] guard-bash.mjs missing. Run: npx houserules update" >&2; exit 1; }';
  function errorLine(id: string, stderr: string): string {
    return JSON.stringify({
      type: 'user',
      sessionId: 'sess-1',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: id,
            is_error: true,
            content: `PreToolUse:Bash hook error: [${wrapper}]: ${stderr}`,
          },
        ],
      },
    });
  }

  it('counts crashes under both notices and a real refusal as a block', () => {
    const corpus = emptyCorpus(['slug']);
    ingestTranscript(
      corpus,
      'h.jsonl',
      [
        errorLine(
          'a',
          '[houserules] guard-bash.mjs missing. Run: npx houserules update',
        ),
        errorLine(
          'b',
          '[houserules] guard-bash.mjs is missing, so this call is blocked. Restore it from your terminal: npx houserules update',
        ),
        errorLine(
          'c',
          'Blocked by houserules guard: git stash dumps the list.',
        ),
      ].join('\n'),
    );

    const report = computeHookHealth(corpus);

    expect(report.rows).toEqual([
      {
        hook: 'PreToolUse:Bash',
        fires: 3,
        nonZero: 3,
        crashes: 2,
        blocks: 1,
        p50: 0,
        p95: 0,
        max: 0,
      },
    ]);
    expect(report.crashSignatures).toEqual([
      { signature: 'missing script: guard-bash.mjs', count: 2 },
    ]);
  });
});

function stopSummaryLine(
  version: string,
  hooks: { command?: string; statusMessage?: string; durationMs?: number }[],
  timestamp?: string,
): string {
  return JSON.stringify({
    type: 'system',
    subtype: 'stop_hook_summary',
    sessionId: 'sess-stop',
    ...(timestamp ? { timestamp } : {}),
    version,
    hookInfos: hooks,
    hookErrors: [],
    preventedContinuation: false,
  });
}

const CHECK_COMMAND =
  '[ -f "$CLAUDE_PROJECT_DIR/.claude/scripts/changeset-check.mjs" ] && exec node "$CLAUDE_PROJECT_DIR/.claude/scripts/changeset-check.mjs" || exit 0';

describe('Stop hook timing from stop_hook_summary records', () => {
  const corpus = emptyCorpus(['slug']);
  ingestTranscript(
    corpus,
    'stop.jsonl',
    [
      stopSummaryLine(
        '2.1.322',
        [
          { command: CHECK_COMMAND, durationMs: 10 },
          { statusMessage: 'Running lint/format auto-fix', durationMs: 200000 },
        ],
        '2026-11-18T10:30:00.000Z',
      ),
      stopSummaryLine('2.1.327', [
        { command: CHECK_COMMAND, durationMs: 20 },
        { statusMessage: 'Running lint:fix + format:fix', durationMs: 50 },
        { statusMessage: 'Some custom hook', durationMs: 5 },
      ]),
      stopSummaryLine('2.1.327', [{ command: CHECK_COMMAND, durationMs: 90 }]),
      stopSummaryLine('2.1.327', [{ command: CHECK_COMMAND }]),
      stopSummaryLine('2.1.327', [{ command: CHECK_COMMAND, durationMs: 40 }]),
    ].join('\n'),
  );
  const report = computeHookHealth(corpus);

  it('names runs by script and computes percentiles on an uneven set', () => {
    expect(report.stopHooks).toEqual([
      // 0 (no durationMs), 10, 20, 40, 90 sorted
      {
        hook: 'changeset-check.mjs',
        runs: 5,
        p50: 20,
        p95: 90,
        max: 90,
        timeouts: 0,
        slowRuns: 0,
      },
      {
        hook: 'lint-format-fix.mjs',
        runs: 2,
        p50: 50,
        p95: 200000,
        max: 200000,
        timeouts: 1,
        slowRuns: 1,
        timedOutRuns: [
          { date: '2026-11-18T10:30:00.000Z', session: 'stop.jsonl' },
        ],
      },
      {
        hook: 'Some custom hook',
        runs: 1,
        p50: 5,
        p95: 5,
        max: 5,
        timeouts: 0,
        slowRuns: 0,
      },
      // per-summary sums: 200010, 75, 90, 0, 40
      {
        hook: '(per Stop total)',
        runs: 5,
        p50: 75,
        p95: 200010,
        max: 200010,
        timeouts: 1,
        slowRuns: 1,
      },
    ]);
  });

  it('renders the table with script basenames only', () => {
    const rendered = renderHookHealth(report).join('\n');
    expect(rendered).toContain(
      'Stop hooks (every stop_hook_summary, quiet runs included):',
    );
    expect(rendered).toContain('changeset-check.mjs');
    expect(rendered).toContain('(per Stop total)');
    expect(rendered).not.toContain('CLAUDE_PROJECT_DIR');
  });

  it('renders nothing for an absent stopHooks and one line for an empty one', () => {
    const base = { rows: [], crashSignatures: [], bashCalls: 0 };
    expect(renderHookHealth(base).join('\n')).not.toContain('Stop');
    expect(renderHookHealth({ ...base, stopHooks: [] }).at(-1)).toBe(
      '  Stop hooks: no Stop runs were recorded.',
    );
  });
});

describe('Stop hook tail share', () => {
  const row = (command: string, durations: number[]) =>
    durations.map((durationMs) =>
      stopSummaryLine('2.1.327', [{ command, durationMs }]),
    );
  const render = (lines: string[]) => {
    const corpus = emptyCorpus(['slug']);
    ingestTranscript(corpus, 'tail.jsonl', lines.join('\n'));
    return computeHookHealth(corpus);
  };

  it('counts 1001 ms as slow and 1000 ms as not', () => {
    const report = render(row('a.mjs', [1000, 1001, 5]));
    expect(report.stopHooks?.[0]).toMatchObject({ runs: 3, slowRuns: 1 });
  });

  it('renders 26 slow of 531 runs beside a p95 of 40 ms (bimodal tail under 5 percent)', () => {
    const durations = [
      ...Array<number>(26).fill(2000),
      ...Array<number>(505).fill(40),
    ];
    const rendered = renderHookHealth(render(row('a.mjs', durations))).join(
      '\n',
    );
    expect(rendered).toContain('26 (4.90%)');
    expect(rendered).toMatch(/a\.mjs\s+531\s+40\s+40\s+26 \(4\.90%\)/);
  });

  it('renders 28 slow of 553 runs beside a p95 of 2000 ms (unimodal slow)', () => {
    const durations = [
      ...Array<number>(28).fill(2000),
      ...Array<number>(525).fill(1000),
    ];
    const report = render(row('a.mjs', durations));
    expect(report.stopHooks?.[0]).toMatchObject({ runs: 553, slowRuns: 28 });
    expect(renderHookHealth(report).join('\n')).toContain('28 (5.06%)');
  });

  it('renders a hook with no slow runs as 0 (0.00%)', () => {
    const rendered = renderHookHealth(render(row('a.mjs', [1, 2, 3]))).join(
      '\n',
    );
    expect(rendered).toContain('0 (0.00%)');
    expect(rendered).not.toContain('NaN');
  });

  it('renders a row from an older document as an absent marker', () => {
    const rendered = renderHookHealth({
      rows: [],
      crashSignatures: [],
      bashCalls: 0,
      stopHooks: [
        { hook: 'a.mjs', runs: 4, p50: 1, p95: 2, max: 3, timeouts: 0 },
      ],
    }).join('\n');
    expect(rendered).toMatch(/a\.mjs\s+4\s+1\s+2\s+-\s+3\s+0/);
  });
});
