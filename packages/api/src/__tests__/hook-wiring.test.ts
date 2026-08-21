import { describe, expect, it } from 'vitest';

import { hookCommand, hookFragment } from '../hook-wiring.js';
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
    expect(hook.async).toBe(true);
  });

  it('omits if, timeout, and async when unset', () => {
    const fragment = hookFragment('PreToolUse', 'Bash', 'guard-bash.mjs');
    const hook = fragment.hooks!.PreToolUse![0]!.hooks[0]!;
    expect('if' in hook).toBe(false);
    expect('timeout' in hook).toBe(false);
    expect('async' in hook).toBe(false);
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
    expect(hook.async).toBe(false);
  });
});
