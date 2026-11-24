import { describe, expect, it } from 'vitest';

import { useInstalledRepo } from '#test/repo';
import { runScript } from '#test/run';
import { dispatchedScriptsFor } from '#test/installed-tree';
import { promptInput } from '#test/hook-input';

import { interimTaskIds } from '../notice-interim.mjs';

const NOTICE = '.claude/scripts/notice-interim.mjs';

function notice(taskId: string, summary: string): string {
  return [
    '<task-notification>',
    `<task-id>${taskId}</task-id>`,
    `<output-file>/private/tmp/claude-501/x/tasks/${taskId}.output</output-file>`,
    '<status>completed</status>',
    `<summary>${summary}</summary>`,
    '<result>This agent has not reported yet: it is waiting on its own background work and will deliver its report through SubagentHandback when that finishes.',
    '</result>',
    '<usage><subagent_tokens>180807</subagent_tokens><tool_uses>71</tool_uses><duration_ms>787961</duration_ms></usage>',
    '</task-notification>',
  ].join('\n');
}

const INTERIM = notice(
  'ae8cc00d1c5f49c69',
  'Agent "Orchestrate ignored-payload phase 4 eject" is waiting on its own background work',
);
const FINISHED = notice(
  'a1b0b31bc7eb81448',
  'Agent "Orchestrate phase 2" finished',
);

describe('interimTaskIds', () => {
  it.each([
    {
      shape: 'one interim notice',
      prompt: INTERIM,
      expected: ['ae8cc00d1c5f49c69'],
    },
    {
      shape: 'two interim notices batched',
      prompt: `${INTERIM}\n${notice('a94cae8baa56ae825', 'Agent "Orchestrate import-region" is waiting on its own background work')}`,
      expected: ['ae8cc00d1c5f49c69', 'a94cae8baa56ae825'],
    },
    {
      shape: 'a finished notice',
      prompt: FINISHED,
      expected: [],
    },
    {
      shape: 'an interim notice batched with a finished one',
      prompt: `${INTERIM}\n${FINISHED}`,
      expected: [],
    },
    {
      shape: 'a background command notice',
      prompt: notice('b7aekvfa9', 'Background command "sleep 270" completed'),
      expected: [],
    },
    {
      shape: 'a subagent hand-back',
      prompt:
        '<agent-message from="a68f30315b83678cd">\n[Subagent hand-back] PHASE x/1: WAVE_CLOSED 1/3',
      expected: [],
    },
    {
      shape: 'a typed prompt quoting an interim notice',
      prompt: `why did this wake you?\n${INTERIM}`,
      expected: [],
    },
  ])('returns $expected for $shape', ({ prompt, expected }) => {
    expect(interimTaskIds(prompt)).toEqual(expected);
  });
});

describe('notice-interim.mjs', () => {
  it('is wired into UserPromptSubmit', () => {
    const root = useInstalledRepo('pnpm-monorepo');

    expect(dispatchedScriptsFor(root, 'UserPromptSubmit')).toContain(
      'notice-interim.mjs',
    );
  });

  it('prints the one-line reply instruction for an interim notice', () => {
    const root = useInstalledRepo('pnpm-monorepo');

    const result = runScript(root, NOTICE, promptInput(INTERIM));

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(
      '[houserules] Interim notice, agent ae8cc00d1c5f49c69 has not reported. Do not review its work. Send each message owed to an orchestrator whose `finished` notice has arrived. Otherwise reply with one line naming what is still running, and make no tool call.\n',
    );
  });

  it('prints nothing for a finished notice', () => {
    const root = useInstalledRepo('pnpm-monorepo');

    const result = runScript(root, NOTICE, promptInput(FINISHED));

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('');
  });

  it('exits 0 and prints nothing on malformed stdin', () => {
    const root = useInstalledRepo('pnpm-monorepo');

    const result = runScript(root, NOTICE, { input: '{not json' });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('');
  });
});
