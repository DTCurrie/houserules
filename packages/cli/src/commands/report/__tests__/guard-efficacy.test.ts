import { describe, expect, it } from 'vitest';
import { emptyCorpus, ingestTranscript } from '../transcript-events.js';
import { computeGuardBlocks, renderGuardEfficacy } from '../guard-efficacy.js';

describe('computeGuardBlocks', () => {
  it('resolves the blocked command when the toolUseID matches an earlier Bash tool_use', () => {
    const corpus = emptyCorpus(['slug']);
    const lines = [
      JSON.stringify({
        type: 'assistant',
        sessionId: 'session-aaaaaaaa-bbbb',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'tool-1',
              name: 'Bash',
              input: { command: 'rm -rf /tmp/x' },
            },
          ],
        },
      }),
      JSON.stringify({
        type: 'attachment',
        sessionId: 'session-aaaaaaaa-bbbb',
        attachment: {
          hookName: 'PreToolUse:Bash',
          exitCode: 2,
          stderr: 'blocked by guard',
          content: '',
          toolUseID: 'tool-1',
        },
      }),
    ].join('\n');

    ingestTranscript(corpus, 'a.jsonl', lines);
    const blocks = computeGuardBlocks(corpus);

    expect(blocks).toEqual([
      {
        session: 'session-',
        blockedCommand: 'rm -rf /tmp/x',
        guard: 'PreToolUse:Bash',
        reason: 'blocked by guard',
      },
    ]);
  });

  it('falls back to a not-found marker when the toolUseID matches nothing', () => {
    const corpus = emptyCorpus(['slug']);
    const lines = JSON.stringify({
      type: 'attachment',
      sessionId: 'session-cccccccc-dddd',
      attachment: {
        hookName: 'PreToolUse:Bash',
        exitCode: 2,
        stderr: 'blocked by guard',
        content: '',
        toolUseID: 'tool-missing',
      },
    });

    ingestTranscript(corpus, 'b.jsonl', lines);
    const blocks = computeGuardBlocks(corpus);

    expect(blocks).toEqual([
      {
        session: 'session-',
        blockedCommand: '(tool_use not found)',
        guard: 'PreToolUse:Bash',
        reason: 'blocked by guard',
      },
    ]);
  });

  it('excludes a fire whose output is a hook crash', () => {
    const corpus = emptyCorpus(['slug']);
    const lines = JSON.stringify({
      type: 'attachment',
      sessionId: 'session-eeeeeeee-ffff',
      attachment: {
        hookName: 'PreToolUse:Bash',
        exitCode: 1,
        stderr: "Cannot find module 'x'",
        content: '',
        toolUseID: 'tool-1',
      },
    });

    ingestTranscript(corpus, 'c.jsonl', lines);
    const blocks = computeGuardBlocks(corpus);

    expect(blocks).toEqual([]);
  });

  it('excludes a PreToolUse fire with exitCode 0', () => {
    const corpus = emptyCorpus(['slug']);
    const lines = JSON.stringify({
      type: 'attachment',
      sessionId: 'session-11111111-2222',
      attachment: {
        hookName: 'PreToolUse:Bash',
        exitCode: 0,
        stderr: '',
        content: '',
        toolUseID: 'tool-1',
      },
    });

    ingestTranscript(corpus, 'd.jsonl', lines);
    const blocks = computeGuardBlocks(corpus);

    expect(blocks).toEqual([]);
  });

  it('excludes a non-PreToolUse fire with a non-zero exit', () => {
    const corpus = emptyCorpus(['slug']);
    const lines = JSON.stringify({
      type: 'attachment',
      sessionId: 'session-33333333-4444',
      attachment: {
        hookName: 'Stop',
        exitCode: 1,
        stderr: 'stop hook failed',
        content: '',
      },
    });

    ingestTranscript(corpus, 'e.jsonl', lines);
    const blocks = computeGuardBlocks(corpus);

    expect(blocks).toEqual([]);
  });

  it('skips a malformed jsonl line and still processes the rest', () => {
    const corpus = emptyCorpus(['slug']);
    const lines = [
      'not json at all {{{',
      JSON.stringify({
        type: 'attachment',
        sessionId: 'session-55555555-6666',
        attachment: {
          hookName: 'PreToolUse:Write',
          exitCode: 2,
          stderr: 'blocked by guard',
          content: '',
          toolUseID: 'tool-missing',
        },
      }),
    ].join('\n');

    ingestTranscript(corpus, 'f.jsonl', lines);
    const blocks = computeGuardBlocks(corpus);

    expect(blocks).toEqual([
      {
        session: 'session-',
        blockedCommand: '(tool_use not found)',
        guard: 'PreToolUse:Write',
        reason: 'blocked by guard',
      },
    ]);
  });

  it('falls back to the file name as the session key when a record has no sessionId', () => {
    const corpus = emptyCorpus(['slug']);
    const lines = JSON.stringify({
      type: 'attachment',
      attachment: {
        hookName: 'PreToolUse:Bash',
        exitCode: 2,
        stderr: 'blocked by guard',
        content: '',
        toolUseID: 'tool-missing',
      },
    });

    ingestTranscript(corpus, 'no-session.jsonl', lines);
    const blocks = computeGuardBlocks(corpus);

    expect(blocks).toEqual([
      {
        session: 'no-sessi',
        blockedCommand: '(tool_use not found)',
        guard: 'PreToolUse:Bash',
        reason: 'blocked by guard',
      },
    ]);
  });
});

describe('renderGuardEfficacy', () => {
  it('renders the empty-corpus finding as a literal line when there are no blocks', () => {
    const lines = renderGuardEfficacy([]);

    expect(lines).toEqual([
      '-- guard efficacy --',
      '',
      '  no genuine blocks in this corpus (every non-zero PreToolUse exit was a hook crash)',
    ]);
  });

  it('leads with a summary table of each guard and reason, most blocks first', () => {
    const lines = renderGuardEfficacy([
      {
        session: 's1',
        blockedCommand: 'a',
        guard: 'PreToolUse:Bash',
        reason: 'stash',
      },
      {
        session: 's1',
        blockedCommand: 'b',
        guard: 'PreToolUse:Read',
        reason: 'big file',
      },
      {
        session: 's2',
        blockedCommand: 'c',
        guard: 'PreToolUse:Bash',
        reason: 'stash',
      },
      {
        session: 's2',
        blockedCommand: 'd',
        guard: 'PreToolUse:Bash',
        reason: 'stash',
      },
      {
        session: 's3',
        blockedCommand: 'e',
        guard: 'PreToolUse:Bash',
        reason: 'force push',
      },
      {
        session: 's3',
        blockedCommand: 'f',
        guard: 'PreToolUse:Read',
        reason: 'big file',
      },
    ]);

    expect(lines.slice(0, 7)).toEqual([
      '-- guard efficacy --',
      '',
      '  guard            reason      blocks',
      '  ---------------  ----------  ------',
      '  PreToolUse:Bash  stash       3     ',
      '  PreToolUse:Read  big file    2     ',
      '  PreToolUse:Bash  force push  1     ',
    ]);
  });

  it('lists each block after the summary with its session and command', () => {
    const lines = renderGuardEfficacy([
      {
        session: 'abc12345',
        blockedCommand: 'rm -rf /tmp/x',
        guard: 'PreToolUse:Bash',
        reason: 'rm',
      },
    ]);

    expect(lines.slice(-2)).toEqual(['', '  abc12345  blocked: rm -rf /tmp/x']);
  });

  it('groups blocks with no guard or reason under the unknown labels', () => {
    const lines = renderGuardEfficacy([
      { session: 'abc12345', blockedCommand: 'x' },
    ]);

    expect(lines[4]).toBe('  (unknown guard)  (no reason recorded)  1     ');
  });

  it('truncates a command over 80 characters to exactly 80 ending in an ellipsis and leaves shorter ones whole', () => {
    const long = 'a'.repeat(81);
    const exact = 'b'.repeat(80);
    const lines = renderGuardEfficacy([
      { session: 's1', blockedCommand: long, guard: 'g', reason: 'r' },
      { session: 's1', blockedCommand: exact, guard: 'g', reason: 'r' },
      { session: 's1', blockedCommand: 'short', guard: 'g', reason: 'r' },
    ]);

    expect(lines.slice(-3)).toEqual([
      `  s1  blocked: ${'a'.repeat(79)}…`,
      `  s1  blocked: ${'b'.repeat(80)}`,
      '  s1  blocked: short',
    ]);
  });

  it('collapses a newline in a command to a space before truncating', () => {
    const lines = renderGuardEfficacy([
      {
        session: 's1',
        blockedCommand: 'echo one\necho two',
        guard: 'g',
        reason: 'r',
      },
    ]);

    expect(lines.at(-1)).toBe('  s1  blocked: echo one echo two');
  });
});

const WRAPPER =
  '[ -f "$CLAUDE_PROJECT_DIR/.claude/scripts/guard-bash.mjs" ] && exec node "$CLAUDE_PROJECT_DIR/.claude/scripts/guard-bash.mjs" || { echo "[houserules] guard-bash.mjs missing. Run: npx houserules update" >&2; exit 1; }';

function toolUseLine(
  id: string,
  name: string,
  input: Record<string, unknown>,
): string {
  return JSON.stringify({
    type: 'assistant',
    sessionId: 'session-aaaaaaaa-bbbb',
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id, name, input }],
    },
  });
}

function hookErrorLine(id: string, tool: string, stderr: string): string {
  return JSON.stringify({
    type: 'user',
    sessionId: 'session-aaaaaaaa-bbbb',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: id,
          is_error: true,
          content: `PreToolUse:${tool} hook error: [${WRAPPER}]: ${stderr}`,
        },
      ],
    },
  });
}

describe('computeGuardBlocks from error tool_results', () => {
  it('counts a default-rule Bash refusal even though the echoed command holds the old notice', () => {
    const corpus = emptyCorpus(['slug']);
    ingestTranscript(
      corpus,
      'g.jsonl',
      [
        toolUseLine('t1', 'Bash', { command: 'git stash' }),
        hookErrorLine(
          't1',
          'Bash',
          'Blocked by houserules guard: git stash dumps the full untracked-file list into context.',
        ),
      ].join('\n'),
    );

    expect(computeGuardBlocks(corpus)).toEqual([
      {
        session: 'session-',
        blockedCommand: 'git stash',
        guard: 'PreToolUse:Bash',
        reason: 'git stash dumps the full untracked-file list into context.',
      },
    ]);
  });

  it('counts a subagent write-gate refusal and names the tool', () => {
    const corpus = emptyCorpus(['slug']);
    const parent = { file: 'parent.jsonl' } as never;
    ingestTranscript(
      corpus,
      'agent-1.jsonl',
      [
        toolUseLine('t2', 'Write', { file_path: '/x/CHANGELOG.md' }),
        hookErrorLine(
          't2',
          'Write',
          'Blocked by houserules guard: subagents may not write here.',
        ),
      ].join('\n'),
      parent,
    );

    expect(computeGuardBlocks(corpus)).toEqual([
      {
        session: 'session-',
        blockedCommand: 'Write',
        guard: 'PreToolUse:Write',
        reason: 'subagents may not write here.',
      },
    ]);
    const session = corpus.sessions.get('session-aaaaaaaa-bbbb');
    expect(session?.hookOutcomes[0]?.isSubagent).toBe(true);
  });

  it('counts a Read-guard refusal', () => {
    const corpus = emptyCorpus(['slug']);
    ingestTranscript(
      corpus,
      'r.jsonl',
      [
        toolUseLine('t3', 'Read', { file_path: '/x/big.log' }),
        hookErrorLine(
          't3',
          'Read',
          'Blocked by houserules guard: read a slice instead.',
        ),
      ].join('\n'),
    );

    expect(computeGuardBlocks(corpus)).toEqual([
      {
        session: 'session-',
        blockedCommand: 'Read',
        guard: 'PreToolUse:Read',
        reason: 'read a slice instead.',
      },
    ]);
  });

  it('does not count a missing-script crash under either notice', () => {
    const corpus = emptyCorpus(['slug']);
    ingestTranscript(
      corpus,
      'c.jsonl',
      [
        toolUseLine('t4', 'Bash', { command: 'ls' }),
        hookErrorLine(
          't4',
          'Bash',
          '[houserules] guard-bash.mjs missing. Run: npx houserules update',
        ),
        toolUseLine('t5', 'Bash', { command: 'ls' }),
        hookErrorLine(
          't5',
          'Bash',
          '[houserules] guard-bash.mjs is missing, so this call is blocked. Restore it from your terminal: npx houserules update',
        ),
      ].join('\n'),
    );

    expect(computeGuardBlocks(corpus)).toEqual([]);
  });

  it('counts a call recorded as both attachment and error tool_result once', () => {
    const corpus = emptyCorpus(['slug']);
    ingestTranscript(
      corpus,
      'd.jsonl',
      [
        toolUseLine('t6', 'Bash', { command: 'git stash' }),
        JSON.stringify({
          type: 'attachment',
          sessionId: 'session-aaaaaaaa-bbbb',
          attachment: {
            hookName: 'PreToolUse:Bash',
            exitCode: 2,
            stderr: 'Blocked by houserules guard: x',
            content: '',
            toolUseID: 't6',
          },
        }),
        hookErrorLine('t6', 'Bash', 'Blocked by houserules guard: x'),
      ].join('\n'),
    );

    expect(computeGuardBlocks(corpus)).toHaveLength(1);
  });
});
