import { describe, expect, it } from 'vitest';

import { useInstalledRepo } from '#test/repo';
import { runScript } from '#test/run';
import { dispatchedScriptsFor } from '#test/installed-tree';

const NOTICE_SCRIPT = '.claude/scripts/manual-mode-notice.mjs';
const LINE =
  '[houserules] Manual mode: every edit a subagent makes raises its own permission prompt in this session.\n';

function payload(prompt: string, mode?: string): { input: string } {
  return {
    input: JSON.stringify(
      mode === undefined ? { prompt } : { prompt, permission_mode: mode },
    ),
  };
}

function run(input: { input: string }) {
  const root = useInstalledRepo('pnpm-monorepo');
  return runScript(root, NOTICE_SCRIPT, input);
}

describe('manual-mode-notice.mjs', () => {
  it('is wired into UserPromptSubmit', () => {
    const root = useInstalledRepo('pnpm-monorepo');

    expect(dispatchedScriptsFor(root, 'UserPromptSubmit')).toContain(
      'manual-mode-notice.mjs',
    );
  });

  it.each([
    { form: 'a leading /orchestrate', prompt: '/orchestrate plan.md' },
    { form: 'a bare /sweep', prompt: '/sweep' },
    { form: 'a /sweep with arguments', prompt: '/sweep --all\nmore' },
    {
      form: 'a command-name tag with a slash',
      prompt:
        '<command-name>/orchestrate</command-name>\n<command-args>x</command-args>',
    },
    {
      form: 'a command-name tag without a slash',
      prompt: '<command-name>sweep</command-name>',
    },
  ])('prints the notice in manual mode for $form', ({ prompt }) => {
    const result = run(payload(prompt, 'default'));

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(LINE);
  });

  it('reads the prompt from prompt_text', () => {
    const result = run({
      input: JSON.stringify({
        prompt_text: '/sweep',
        permission_mode: 'default',
      }),
    });

    expect(result.stdout).toBe(LINE);
  });

  it.each([
    { mode: 'acceptEdits' },
    { mode: 'auto' },
    { mode: 'bypassPermissions' },
    { mode: 'plan' },
    { mode: undefined },
  ])('prints nothing for /orchestrate in mode $mode', ({ mode }) => {
    const result = run(payload('/orchestrate plan.md', mode));

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('');
  });

  it.each([
    { prompt: '/orchestrated' },
    { prompt: '/sweeping now' },
    { prompt: 'please orchestrate this' },
  ])('prints nothing in manual mode for "$prompt"', ({ prompt }) => {
    const result = run(payload(prompt, 'default'));

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('');
  });

  it('exits 0 and prints nothing on malformed stdin', () => {
    const result = run({ input: '{not json' });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('');
  });
});
