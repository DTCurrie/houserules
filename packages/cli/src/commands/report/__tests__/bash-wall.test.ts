import { describe, expect, it } from 'vitest';
import {
  bashFamily,
  extractBashCalls,
  renderBashWall,
  summarizeBashWall,
} from '../bash-wall.js';
import type { BashWallReport, SessionBashCall } from '../bash-wall.js';

function useRecord(
  timestamp: string,
  blocks: { id: string; name?: string; input: Record<string, unknown> }[],
) {
  return {
    type: 'assistant',
    timestamp,
    message: {
      content: blocks.map((block) => ({
        type: 'tool_use',
        id: block.id,
        name: block.name ?? 'Bash',
        input: block.input,
      })),
    },
  };
}

function resultRecord(timestamp: string, id: string) {
  return {
    type: 'user',
    timestamp,
    message: {
      content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }],
    },
  };
}

function timedCall(
  overrides: Partial<SessionBashCall> & { seconds: number },
): SessionBashCall {
  return {
    id: 'id',
    command: 'pnpm test',
    family: 'pnpm test',
    startMs: Date.parse('2026-11-22T10:00:00.000Z'),
    endMs: null,
    isBackground: false,
    isSubagent: false,
    session: 'session-one',
    ...overrides,
  };
}

describe('bashFamily', () => {
  it.each([
    { command: 'FOO=1 BAR=x make build', family: 'make' },
    { command: 'cd packages/cli && pnpm test', family: 'pnpm test' },
    { command: 'S=/tmp/run; ls $S', family: 'ls' },
    { command: 'start=$(date +%s); pnpm check', family: 'pnpm check' },
    { command: 'exec </dev/null; python3 - <<EOF', family: 'python3' },
    { command: '(pnpm check 2>&1; echo done) | tail', family: 'pnpm check' },
    { command: 'cd /repo && W=plans/x\ngrep -n Status $W', family: 'grep' },
    { command: 'git log --oneline | head -5', family: 'git log' },
    { command: 'pnpm --filter @houserules/cli run test', family: 'pnpm test' },
    { command: 'pnpm --filter=@x/y build', family: 'pnpm build' },
    { command: 'pnpm exec vitest run', family: 'pnpm vitest' },
    { command: 'npx vitest run', family: 'npx vitest' },
    { command: 'node scripts/foo.mjs --flag', family: 'foo.mjs' },
    { command: 'node --test x.test.mjs', family: 'node --test' },
    { command: 'git -C some/dir status', family: 'git status' },
    { command: 'gh pr view 12', family: 'gh pr' },
    { command: 'ls -la src', family: 'ls' },
    { command: 'echo "a && b" && ls', family: 'echo' },
    { command: 'false || pnpm test', family: 'false' },
    { command: 'pnpm', family: 'pnpm' },
  ])('maps $command to $family', ({ command, family }) => {
    expect(bashFamily(command)).toBe(family);
  });
});

describe('extractBashCalls', () => {
  it('times a foreground call from its tool_use record to its result record', () => {
    const calls = extractBashCalls(
      [
        useRecord('2026-11-22T10:00:00.000Z', [
          { id: 'a', input: { command: 'pnpm test' } },
        ]),
        resultRecord('2026-11-22T10:00:02.5004Z', 'a'),
      ],
      { isSubagent: false },
    );

    expect(calls).toEqual([
      {
        id: 'a',
        command: 'pnpm test',
        family: 'pnpm test',
        startMs: Date.parse('2026-11-22T10:00:00.000Z'),
        endMs: Date.parse('2026-11-22T10:00:02.500Z'),
        seconds: 2.5,
        isBackground: false,
        isSubagent: false,
      },
    ]);
  });

  it('flags a background call and leaves it untimed', () => {
    const [call] = extractBashCalls(
      [
        useRecord('2026-11-22T10:00:00.000Z', [
          { id: 'a', input: { command: 'pnpm dev', run_in_background: true } },
        ]),
        resultRecord('2026-11-22T10:00:01.000Z', 'a'),
      ],
      { isSubagent: true },
    );

    expect(call?.isBackground).toBe(true);
    expect(call?.seconds).toBeNull();
    expect(call?.isSubagent).toBe(true);
  });

  it('times two parallel calls separately by their result timestamps', () => {
    const calls = extractBashCalls(
      [
        useRecord('2026-11-22T10:00:00.000Z', [
          { id: 'a', input: { command: 'ls' } },
          { id: 'b', input: { command: 'pwd' } },
        ]),
        resultRecord('2026-11-22T10:00:01.000Z', 'a'),
        resultRecord('2026-11-22T10:00:04.250Z', 'b'),
      ],
      { isSubagent: false },
    );

    expect(calls.map((call) => [call.id, call.seconds])).toEqual([
      ['a', 1],
      ['b', 4.25],
    ]);
  });

  it('counts a call with no result and leaves it untimed', () => {
    const calls = extractBashCalls(
      [
        useRecord('2026-11-22T10:00:00.000Z', [
          { id: 'a', input: { command: 'ls' } },
        ]),
      ],
      { isSubagent: false },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.endMs).toBeNull();
    expect(calls[0]?.seconds).toBeNull();
  });

  it('counts a repeated tool_use record once, timed from its first record', () => {
    const calls = extractBashCalls(
      [
        useRecord('2026-11-22T10:00:00.000Z', [
          { id: 'a', input: { command: 'ls' } },
        ]),
        useRecord('2026-11-22T10:00:01.000Z', [
          { id: 'a', input: { command: 'ls' } },
        ]),
        resultRecord('2026-11-22T10:00:02.500Z', 'a'),
      ],
      { isSubagent: false },
    );

    expect(calls.map((call) => call.seconds)).toEqual([2.5]);
  });

  it('leaves a call untimed when its tool_use record has no timestamp', () => {
    const record = useRecord('x', [{ id: 'a', input: { command: 'ls' } }]);
    const calls = extractBashCalls(
      [
        { ...record, timestamp: undefined },
        resultRecord('2026-11-22T10:00:01.000Z', 'a'),
      ],
      { isSubagent: false },
    );

    expect(calls[0]?.startMs).toBeNull();
    expect(calls[0]?.seconds).toBeNull();
  });

  it('ignores a tool_use that is not Bash', () => {
    const calls = extractBashCalls(
      [
        useRecord('2026-11-22T10:00:00.000Z', [
          { id: 'a', name: 'Read', input: { command: 'ls' } },
        ]),
        resultRecord('2026-11-22T10:00:01.000Z', 'a'),
      ],
      { isSubagent: false },
    );

    expect(calls).toEqual([]);
  });

  it('tolerates malformed records', () => {
    const calls = extractBashCalls(
      [
        null,
        'text',
        42,
        {},
        { message: { content: 'plain string' } },
        { message: { content: [null, 'x', { type: 'tool_result' }] } },
      ],
      { isSubagent: false },
    );

    expect(calls).toEqual([]);
  });
});

describe('summarizeBashWall', () => {
  it('takes the middle value as the median of an odd count and the mean of the middle two when even', () => {
    const odd = summarizeBashWall([
      timedCall({ seconds: 1 }),
      timedCall({ seconds: 9 }),
      timedCall({ seconds: 2 }),
    ]);
    const even = summarizeBashWall([
      timedCall({ seconds: 1 }),
      timedCall({ seconds: 2 }),
      timedCall({ seconds: 4 }),
      timedCall({ seconds: 10 }),
    ]);

    expect(odd.families[0]?.medianSeconds).toBe(2);
    expect(even.families[0]?.medianSeconds).toBe(3);
  });

  it('takes p90 by nearest rank and sums seconds to 3 decimals', () => {
    const calls = Array.from({ length: 10 }, (_, i) =>
      timedCall({ seconds: i + 1 }),
    );
    const sums = summarizeBashWall([
      timedCall({ seconds: 0.1 }),
      timedCall({ seconds: 0.2 }),
    ]);

    expect(summarizeBashWall(calls).families[0]?.p90Seconds).toBe(9);
    expect(sums.families[0]?.seconds).toBe(0.3);
  });

  it('counts background, unanswered, and subagent calls', () => {
    const untimed = { seconds: null, endMs: null };
    const report = summarizeBashWall([
      timedCall({ seconds: 1, isSubagent: true }),
      timedCall({ seconds: 2 }),
      { ...timedCall({ seconds: 0 }), ...untimed, isBackground: true },
      { ...timedCall({ seconds: 0 }), ...untimed },
    ]);

    expect(report).toMatchObject({
      calls: 4,
      timed: 2,
      background: 1,
      unanswered: 1,
      includesSubagents: true,
    });
    expect(report.families[0]).toMatchObject({ calls: 2, subagentCalls: 1 });
  });

  it('orders families by total seconds then name and keeps the limit', () => {
    const report = summarizeBashWall(
      [
        timedCall({ seconds: 5, family: 'b' }),
        timedCall({ seconds: 5, family: 'a' }),
        timedCall({ seconds: 9, family: 'c' }),
        timedCall({ seconds: 1, family: 'd' }),
      ],
      { families: 3 },
    );

    expect(report.families.map((row) => row.family)).toEqual(['c', 'a', 'b']);
  });

  it('lists the slowest calls slowest first, ties by start, cut to the limit and command length', () => {
    const report = summarizeBashWall(
      [
        timedCall({
          seconds: 3,
          command: 'later',
          startMs: Date.parse('2026-11-22T11:00:00.000Z'),
        }),
        timedCall({ seconds: 3, command: 'earlier' }),
        timedCall({ seconds: 8, command: 'x'.repeat(200) }),
        timedCall({ seconds: 1, command: 'fast' }),
      ],
      { slowest: 3 },
    );

    expect(report.slowest.map((call) => call.command.length)).toEqual([
      120, 7, 5,
    ]);
    expect(report.slowest.map((call) => call.seconds)).toEqual([8, 3, 3]);
    expect(report.slowest[1]?.startedAt).toBe('2026-11-22T10:00:00.000Z');
    expect(report.slowest[0]?.session).toBe('session-one');
  });
});

describe('renderBashWall', () => {
  const report: BashWallReport = {
    calls: 3,
    timed: 2,
    background: 1,
    unanswered: 0,
    includesSubagents: false,
    families: [
      {
        family: 'pnpm test',
        calls: 2,
        subagentCalls: 0,
        seconds: 12.5,
        medianSeconds: 6.25,
        p90Seconds: 10,
      },
    ],
    slowest: [
      {
        family: 'pnpm test',
        command: 'pnpm test',
        seconds: 10,
        session: 'abcdef123456',
        startedAt: '2026-11-22T10:00:00.000Z',
        isSubagent: false,
      },
    ],
  };

  it('says parallel calls overlap and that subagents are not counted', () => {
    const lines = renderBashWall(report);

    expect(lines[0]).toBe('-- bash wall time --');
    expect(lines[1]).toBe(
      "  parallel calls overlap, so family totals can exceed a session's wall. subagent transcripts are not counted.",
    );
  });

  it('says subagent transcripts are counted when the report includes them', () => {
    const lines = renderBashWall({ ...report, includesSubagents: true });

    expect(lines[1]).toBe(
      "  parallel calls overlap, so family totals can exceed a session's wall. subagent transcripts are counted.",
    );
  });

  it('renders the counts, the family table, and the slowest calls', () => {
    const lines = renderBashWall(report);

    expect(lines[2]).toBe('  calls 3, timed 2, background 1, unanswered 0');
    expect(lines[4]).toMatch(
      /^ {2}family +calls +total s +median s +p90 s +subagent calls$/,
    );
    expect(lines[6]).toMatch(/^ {2}pnpm test +2 +12\.50 +6\.25 +10\.00 +0 *$/);
    expect(lines.at(-1)).toBe(
      '    10.00s  pnpm test  abcdef12  2026-11-22T10:00:00.000Z  pnpm test',
    );
  });

  it('renders no lines for an undefined or empty report', () => {
    expect(renderBashWall(undefined)).toEqual([]);
    expect(renderBashWall({ ...report, calls: 0 })).toEqual([]);
  });
});
