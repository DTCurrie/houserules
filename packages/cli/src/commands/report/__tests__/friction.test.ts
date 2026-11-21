import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { emptyCorpus, ingestTranscript } from '../transcript-events.js';
import {
  computeFriction,
  isReadOnlyGitCheck,
  readTrimInstalled,
  renderFriction,
} from '../friction.js';
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

function bashCorpus(command: string, times: number) {
  const content = Array.from({ length: times }, (_, index) => ({
    type: 'tool_use',
    id: `tu-${index}`,
    name: 'Bash',
    input: { command },
  }));
  return corpusFrom(
    JSON.stringify({
      type: 'assistant',
      sessionId: 'repeat-session',
      message: { role: 'assistant', content },
    }),
  );
}

const ORCHESTRATE_CHECK =
  "cd /Users/devin/Projects/houserules && git status --short | grep '^ T\\|^T '";

describe('isReadOnlyGitCheck', () => {
  it.each([
    { command: ORCHESTRATE_CHECK, expected: true },
    { command: 'git status --short', expected: true },
    { command: 'git diff --name-only | head', expected: true },
    { command: 'git diff', expected: false },
    { command: 'git add -A', expected: false },
    { command: 'pnpm test', expected: false },
  ])('returns $expected for "$command"', ({ command, expected }) => {
    expect(isReadOnlyGitCheck(command)).toBe(expected);
  });
});

describe('computeFriction retries over read-only git checks', () => {
  it('records no run when the orchestrate tree check repeats five times', () => {
    const report = computeFriction(bashCorpus(ORCHESTRATE_CHECK, 5));

    expect(report.retryRuns).toEqual([]);
  });

  it('still records one run of five for a repeated real command', () => {
    const report = computeFriction(bashCorpus('pnpm test', 5));

    expect(report.retryRuns).toEqual([
      { session: 'repeat-s', length: 5, command: 'pnpm test' },
    ]);
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

function useAndResult(
  id: string,
  name: string,
  content: string,
  session = 'sizes-session',
): string[] {
  return [
    JSON.stringify({
      type: 'assistant',
      sessionId: session,
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id, name, input: { command: 'x' } }],
      },
    }),
    JSON.stringify({
      type: 'user',
      sessionId: session,
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: id, content }],
      },
    }),
  ];
}

describe('computeFriction toolResultSizes', () => {
  it('tallies Read and Bash results with bytes and over-cap counts', () => {
    const big = 'a'.repeat(20000);
    const corpus = corpusFrom(
      [
        ...useAndResult('r1', 'Read', big),
        ...useAndResult('r2', 'Read', 'tiny'),
        ...useAndResult('b1', 'Bash', 'hello'),
        ...useAndResult('g1', 'Grep', big),
      ].join('\n'),
    );

    const sizes = computeFriction(corpus).toolResultSizes;

    expect(sizes).toEqual({
      capBytes: 16384,
      read: {
        results: 2,
        bytes: 20002 + 6,
        overCap: 1,
        excessBytes: 20002 - 16384,
      },
      bash: { results: 1, bytes: 7, overCap: 0, excessBytes: 0 },
    });
  });

  it('sums bytes past the cap over the over-cap results only', () => {
    const corpus = corpusFrom(
      [
        // The measured size is the text plus two bytes, so these are 20,000 and 10,000.
        ...useAndResult('r1', 'Read', 'a'.repeat(19998)),
        ...useAndResult('r2', 'Read', 'a'.repeat(9998)),
      ].join('\n'),
    );

    const read = computeFriction(corpus).toolResultSizes?.read;

    expect(read?.overCap).toBe(1);
    expect(read?.excessBytes).toBe(3616);
  });

  it('counts a result with no matching tool_use for neither tool', () => {
    const corpus = corpusFrom(
      JSON.stringify({
        type: 'user',
        sessionId: 'miss-session',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'nope',
              content: 'a'.repeat(20000),
            },
          ],
        },
      }),
    );

    const sizes = computeFriction(corpus).toolResultSizes;

    expect(sizes?.read.results).toBe(0);
    expect(sizes?.bash.results).toBe(0);
  });
});

describe('renderFriction result sizes', () => {
  const base: FrictionReport = {
    compactedSessions: [],
    bulkByTool: [],
    retryRuns: [],
    denials: [],
    interrupts: 0,
  };
  const sizes = {
    capBytes: 16384,
    read: { results: 2, bytes: 40000, overCap: 1 },
    bash: { results: 0, bytes: 0, overCap: 0 },
  };
  const sizeLine =
    '  result size vs 16,384-byte trim cap: Read 2 results, avg 20,000 bytes, 1 over cap; Bash 0 results, avg 0 bytes, 0 over cap';

  it('prints the size line and the trim hint when trim is missing and a result is over cap', () => {
    const lines = renderFriction({
      ...base,
      toolResultSizes: { ...sizes, isTrimInstalled: false },
    });

    const index = lines.indexOf(sizeLine);
    expect(index).toBeGreaterThan(-1);
    expect(lines[index + 1]).toBe(
      '    tool-output-trim is not installed. Enable it with `npx houserules modules`.',
    );
  });

  it('omits the hint when trim is installed, unknown, or nothing is over cap', () => {
    for (const toolResultSizes of [
      { ...sizes, isTrimInstalled: true },
      { ...sizes },
      {
        ...sizes,
        read: { results: 1, bytes: 5, overCap: 0 },
        isTrimInstalled: false,
      },
    ]) {
      const lines = renderFriction({ ...base, toolResultSizes });
      expect(lines.some((line) => line.includes('result size vs'))).toBe(true);
      expect(lines.some((line) => line.includes('tool-output-trim'))).toBe(
        false,
      );
    }
  });

  it('prints no size line when toolResultSizes is absent', () => {
    const lines = renderFriction(base);

    expect(lines.some((line) => line.includes('result size vs'))).toBe(false);
  });
});

describe('readTrimInstalled', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true });
  });

  function installWith(modules: string[] | null): string {
    const root = mkdtempSync(join(tmpdir(), 'trim-installed-'));
    dirs.push(root);
    if (modules) {
      mkdirSync(join(root, '.claude'));
      writeFileSync(
        join(root, '.claude', 'houserules.manifest.json'),
        JSON.stringify({
          kitVersion: '0.0.0',
          installedAt: '2026-01-01',
          modules,
          files: {},
        }),
      );
    }
    return root;
  }

  it('is true when the manifest records the module', () => {
    expect(readTrimInstalled(installWith(['core', 'tool-output-trim']))).toBe(
      true,
    );
  });

  it('is false when the manifest omits the module', () => {
    expect(readTrimInstalled(installWith(['core']))).toBe(false);
  });

  it('is undefined when nothing is installed', () => {
    expect(readTrimInstalled(installWith(null))).toBeUndefined();
  });

  it('reads the config modules over a disagreeing manifest', () => {
    const root = installWith(['core']);
    writeFileSync(
      join(root, '.claude', 'houserules.config.json'),
      JSON.stringify({ version: 2, modules: ['core', 'tool-output-trim'] }),
    );

    expect(readTrimInstalled(root)).toBe(true);
  });
});
