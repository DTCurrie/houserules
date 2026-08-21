import { describe, expect, it } from 'vitest';

import { hookCommand } from '../hook-wiring.js';
import {
  isKitStockCommand,
  mergeSettings,
  reconcileSettings,
  type Settings,
  type SettingsFragment,
  type SettingsSignature,
} from '../merge-settings.js';

const SCRIPT = 'guard-bash.mjs';
const HISTORICAL_COMMAND = `node "$CLAUDE_PROJECT_DIR/.claude/scripts/${SCRIPT}"`;
const USER_EDITED_COMMAND = `${hookCommand(SCRIPT)} --strict`;

function fragmentFor(
  event: string,
  matcher: string | null,
  script: string,
): SettingsFragment {
  const hook = { type: 'command' as const, command: hookCommand(script) };
  return {
    hooks: {
      [event]: [matcher ? { matcher, hooks: [hook] } : { hooks: [hook] }],
    },
  };
}

describe('isKitStockCommand', () => {
  it('is true for the current guarded form hookCommand emits for that basename', () => {
    expect(isKitStockCommand(hookCommand(SCRIPT), SCRIPT)).toBe(true);
  });

  it('is true for a known historical stock format', () => {
    expect(isKitStockCommand(HISTORICAL_COMMAND, SCRIPT)).toBe(true);
  });

  it('is true for the pre-sweep houserules wrapper with the stdout echo fallback', () => {
    const preSweep = `[ -f "$CLAUDE_PROJECT_DIR/.claude/scripts/${SCRIPT}" ] && exec node "$CLAUDE_PROJECT_DIR/.claude/scripts/${SCRIPT}" || echo "[houserules] ${SCRIPT} missing. Run: npx houserules update"`;
    expect(isKitStockCommand(preSweep, SCRIPT)).toBe(true);
  });

  it('is true for the pre-rename agent-kit wrapper', () => {
    const agentKit = `[ -f "$CLAUDE_PROJECT_DIR/.claude/scripts/${SCRIPT}" ] && exec node "$CLAUDE_PROJECT_DIR/.claude/scripts/${SCRIPT}" || echo "[kit] ${SCRIPT} missing — run: npx agent-kit update"`;
    expect(isKitStockCommand(agentKit, SCRIPT)).toBe(true);
  });

  it('is false for a different basename entirely', () => {
    expect(isKitStockCommand(HISTORICAL_COMMAND, 'other-hook.mjs')).toBe(false);
  });

  it('is false for a user-edited variant with extra flags', () => {
    expect(isKitStockCommand(USER_EDITED_COMMAND, SCRIPT)).toBe(false);
  });

  it('is false for a command with a custom fallback message', () => {
    const custom = `[ -f "$CLAUDE_PROJECT_DIR/.claude/scripts/${SCRIPT}" ] && exec node "$CLAUDE_PROJECT_DIR/.claude/scripts/${SCRIPT}" || echo "custom fallback"`;
    expect(isKitStockCommand(custom, SCRIPT)).toBe(false);
  });
});

describe('mergeSettings hook upgrade', () => {
  it('upgrades a stale historical wrapper to the current form in place', () => {
    const existing: Settings = {
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: HISTORICAL_COMMAND }],
          },
        ],
      },
    };
    const { merged, changes } = mergeSettings(
      existing,
      fragmentFor('PreToolUse', 'Bash', SCRIPT),
    );
    const hooks = merged.hooks!.PreToolUse![0]!.hooks;
    expect(hooks).toHaveLength(1);
    expect(hooks[0]!.command).toBe(hookCommand(SCRIPT));
    expect(changes.some((c) => c.detail.includes('upgraded'))).toBe(true);
  });

  it('preserves a user-edited command with the same basename byte-identical', () => {
    const existing: Settings = {
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: USER_EDITED_COMMAND }],
          },
        ],
      },
    };
    const { merged, changes } = mergeSettings(
      existing,
      fragmentFor('PreToolUse', 'Bash', SCRIPT),
    );
    const hooks = merged.hooks!.PreToolUse![0]!.hooks;
    expect(hooks).toHaveLength(1);
    expect(hooks[0]!.command).toBe(USER_EDITED_COMMAND);
    expect(changes).toHaveLength(0);
  });
});

describe('reconcileSettings', () => {
  const recorded: SettingsSignature = {
    hooks: [{ event: 'PreToolUse', matcher: 'Bash', script: SCRIPT }],
    permissions: [],
  };

  it('drops a recorded, undeclared, stock tuple', () => {
    const existing: Settings = {
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: hookCommand(SCRIPT) }],
          },
        ],
      },
    };
    const { merged, dropped } = reconcileSettings(existing, [], recorded);
    expect(merged.hooks).toBeUndefined();
    expect(dropped).toEqual([
      { event: 'PreToolUse', matcher: 'Bash', script: SCRIPT },
    ]);
  });

  it('keeps a recorded, undeclared tuple whose command a user edited', () => {
    const existing: Settings = {
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: USER_EDITED_COMMAND }],
          },
        ],
      },
    };
    const { merged, dropped } = reconcileSettings(existing, [], recorded);
    expect(merged.hooks!.PreToolUse![0]!.hooks).toHaveLength(1);
    expect(dropped).toHaveLength(0);
  });

  it('keeps an undeclared tuple that is not in the recorded signature', () => {
    const existing: Settings = {
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [
              {
                type: 'command',
                command: hookCommand('hand-added-lookalike.mjs'),
              },
            ],
          },
        ],
      },
    };
    const { merged, dropped } = reconcileSettings(existing, [], recorded);
    expect(merged.hooks!.PreToolUse![0]!.hooks).toHaveLength(1);
    expect(dropped).toHaveLength(0);
  });

  it('keeps a declared tuple from a current fragment', () => {
    const existing: Settings = {
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: hookCommand(SCRIPT) }],
          },
        ],
      },
    };
    const currentFragments = [fragmentFor('PreToolUse', 'Bash', SCRIPT)];
    const { merged, dropped } = reconcileSettings(
      existing,
      currentFragments,
      recorded,
    );
    expect(merged.hooks!.PreToolUse![0]!.hooks).toHaveLength(1);
    expect(dropped).toHaveLength(0);
  });

  it('reconciles nothing when recorded is undefined', () => {
    const existing: Settings = {
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: hookCommand(SCRIPT) }],
          },
        ],
      },
    };
    const { merged, dropped } = reconcileSettings(existing, [], undefined);
    expect(merged.hooks!.PreToolUse![0]!.hooks).toHaveLength(1);
    expect(dropped).toHaveLength(0);
  });

  it('drops an old matcher and mergeSettings appends the new one when a hook moves matchers', () => {
    const existing: Settings = {
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: hookCommand(SCRIPT) }],
          },
        ],
      },
    };
    const movedFragment = fragmentFor('PreToolUse', 'Edit', SCRIPT);
    const { merged: reconciled, dropped } = reconcileSettings(
      existing,
      [movedFragment],
      recorded,
    );
    expect(dropped).toEqual([
      { event: 'PreToolUse', matcher: 'Bash', script: SCRIPT },
    ]);
    expect(reconciled.hooks).toBeUndefined();

    const { merged: final } = mergeSettings(reconciled, movedFragment);
    const groups = final.hooks!.PreToolUse!;
    expect(groups).toHaveLength(1);
    expect(groups[0]!.matcher).toBe('Edit');
    expect(groups[0]!.hooks[0]!.command).toBe(hookCommand(SCRIPT));
  });
});
