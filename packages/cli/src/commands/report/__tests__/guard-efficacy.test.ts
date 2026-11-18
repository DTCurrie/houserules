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
      { session: 'session-', blockedCommand: 'rm -rf /tmp/x' },
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
      { session: 'session-', blockedCommand: '(tool_use not found)' },
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
      { session: 'session-', blockedCommand: '(tool_use not found)' },
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
      { session: 'no-sessi', blockedCommand: '(tool_use not found)' },
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

  it('renders one line per block with the session and blocked command', () => {
    const lines = renderGuardEfficacy([
      { session: 'abc12345', blockedCommand: 'rm -rf /tmp/x' },
      { session: 'def67890', blockedCommand: '(tool_use not found)' },
    ]);

    expect(lines).toEqual([
      '-- guard efficacy --',
      '',
      '  abc12345  blocked: rm -rf /tmp/x',
      '  def67890  blocked: (tool_use not found)',
    ]);
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
      { session: 'session-', blockedCommand: 'git stash' },
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
      { session: 'session-', blockedCommand: 'Write' },
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
      { session: 'session-', blockedCommand: 'Read' },
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
