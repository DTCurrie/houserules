import { describe, expect, it } from 'vitest';

import {
  hookCommand,
  hookFragment,
  isGuardedHookCommand,
} from '../hook-wiring.js';
import { mergeSettings } from '../merge-settings.js';

describe('hookFragment', () => {
  it('carries only type, command, and statusMessage when no options are given', () => {
    const fragment = hookFragment('PreToolUse', 'Bash', 'guard-bash.mjs');
    const hook = fragment.hooks!.PreToolUse![0]!.hooks[0]!;
    expect(hook).toEqual({
      type: 'command',
      command: hookCommand('guard-bash.mjs'),
    });
  });

  it('lands if, timeout, and async on the emitted hook entry when set', () => {
    const fragment = hookFragment(
      'PreToolUse',
      'Bash',
      'guard-bash.mjs',
      undefined,
      { if: '${CLAUDE_TOOL_NAME} == "Bash"', timeout: 30, async: true },
    );
    const hook = fragment.hooks!.PreToolUse![0]!.hooks[0]!;
    expect(hook.if).toBe('${CLAUDE_TOOL_NAME} == "Bash"');
    expect(hook.timeout).toBe(30);
    expect(hook.async, 'hook.async is set to true').toBe(true);
  });

  it('omits if, timeout, and async when unset', () => {
    const fragment = hookFragment('PreToolUse', 'Bash', 'guard-bash.mjs');
    const hook = fragment.hooks!.PreToolUse![0]!.hooks[0]!;
    expect('if' in hook, 'hook has no if key').toBe(false);
    expect('timeout' in hook, 'hook has no timeout key').toBe(false);
    expect('async' in hook, 'hook has no async key').toBe(false);
  });

  it('round-trips if, timeout, and async through mergeSettings', () => {
    const fragment = hookFragment(
      'PreToolUse',
      'Bash',
      'guard-bash.mjs',
      undefined,
      { if: 'always', timeout: 12, async: false },
    );
    const { merged } = mergeSettings(null, fragment);
    const hook = merged.hooks!.PreToolUse![0]!.hooks[0]!;
    expect(hook.if).toBe('always');
    expect(hook.timeout).toBe(12);
    expect(hook.async, 'hook.async is set to false').toBe(false);
  });
});

describe('hookFragment fallback by event', () => {
  function commandFor(event: string): string {
    return hookFragment(event, null, 'x.mjs').hooks![event]![0]!.hooks[0]!
      .command;
  }

  it('writes the stderr notice and exit 1 for PreToolUse', () => {
    expect(commandFor('PreToolUse')).toMatch(
      / \|\| \{ echo "\[houserules\] x\.mjs missing\. Run: npx houserules update" >&2; exit 1; \}$/,
    );
  });

  it('writes the stdout notice then exit 0 for SessionStart', () => {
    const command = commandFor('SessionStart');
    expect(command).toMatch(
      / \|\| \{ echo "\[houserules\] x\.mjs missing\. Run: npx houserules update"; exit 0; \}$/,
    );
    expect(command).not.toContain('>&2');
  });

  it('writes a silent exit 0 for Stop', () => {
    expect(commandFor('Stop')).toMatch(/ \|\| exit 0$/);
  });
});

describe('isGuardedHookCommand', () => {
  it.each(['guard', 'hint', 'silent'] as const)(
    'is true for the %s form',
    (fallback) => {
      expect(isGuardedHookCommand(hookCommand('x.mjs', fallback))).toBe(true);
    },
  );

  it('is false for a bare node invocation', () => {
    expect(isGuardedHookCommand('node .claude/scripts/x.mjs')).toBe(false);
  });
});
