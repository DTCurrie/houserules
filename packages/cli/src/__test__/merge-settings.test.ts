import { describe, expect, it } from 'vitest';

import { mergeSettings, parseSettingsText } from '@agent-kit/api/internal';
import type { Settings, SettingsFragment } from '@agent-kit/api';

const KIT_FRAGMENT: SettingsFragment = {
  permissions: { allow: ['Bash(git status:*)', 'Bash(git diff:*)'] },
  hooks: {
    PreToolUse: [
      {
        matcher: 'Bash',
        hooks: [
          {
            type: 'command',
            command:
              'node "$CLAUDE_PROJECT_DIR/.claude/scripts/guard-bash.mjs"',
          },
        ],
      },
    ],
    Stop: [
      {
        hooks: [
          {
            type: 'command',
            command:
              'node "$CLAUDE_PROJECT_DIR/.claude/scripts/lint-format-fix.mjs"',
          },
        ],
      },
    ],
  },
};

describe('mergeSettings', () => {
  const existing: Settings = {
    permissions: { allow: ['Bash(echo hi)'] },
    hooks: {
      PreToolUse: [
        {
          matcher: 'Bash',
          hooks: [
            { type: 'command', command: 'node   ./my-hook.js   --check' },
          ],
        },
      ],
    },
    otherKey: { untouched: true },
  };

  it('preserves an existing permission entry verbatim', () => {
    const { merged } = mergeSettings(existing, KIT_FRAGMENT);
    expect(merged.permissions?.allow?.[0]).toBe('Bash(echo hi)');
  });

  it('appends the kit permission entries to the existing list', () => {
    const { merged } = mergeSettings(existing, KIT_FRAGMENT);
    expect(merged.permissions?.allow).toContain('Bash(git status:*)');
  });

  it('keeps a user hook byte-identical while appending the kit hook to the same matcher group', () => {
    const { merged } = mergeSettings(existing, KIT_FRAGMENT);
    const pre = merged.hooks!.PreToolUse;
    if (!pre) throw new Error('expected a PreToolUse hook list');
    expect(pre).toHaveLength(1);
    const group = pre[0];
    if (!group) throw new Error('expected a matcher group');
    const [first, second] = group.hooks;
    if (!first || !second) throw new Error('expected two hooks');
    expect(first.command).toBe('node   ./my-hook.js   --check');
    expect(second.command).toContain('guard-bash.mjs');
  });

  it('leaves unrelated top-level keys untouched', () => {
    const { merged } = mergeSettings(existing, KIT_FRAGMENT);
    expect(merged.otherKey).toEqual({ untouched: true });
  });

  it('counts each added permission and hook as a change', () => {
    const { changes } = mergeSettings(existing, KIT_FRAGMENT);
    expect(changes, '2 permissions + 2 hooks').toHaveLength(4);
  });

  it('is idempotent on a second merge: zero changes, byte-identical output', () => {
    const first = mergeSettings({}, KIT_FRAGMENT);
    const second = mergeSettings(first.merged, KIT_FRAGMENT);
    expect(second.changes).toHaveLength(0);
    expect(JSON.stringify(second.merged)).toBe(JSON.stringify(first.merged));
  });

  describe("when the user has edited a kit hook's script", () => {
    const editedExisting: Settings = {
      hooks: {
        Stop: [
          {
            hooks: [
              {
                type: 'command',
                command:
                  'node .claude/scripts/lint-format-fix.mjs --my-extra-flag',
              },
            ],
          },
        ],
      },
    };

    it('dedupes by script identity, keeping only one hook entry', () => {
      const { merged } = mergeSettings(editedExisting, KIT_FRAGMENT);
      const stopCommands = merged.hooks!.Stop!.flatMap((g) =>
        g.hooks.map((h) => h.command),
      );
      expect(
        stopCommands.filter((c) => c.includes('lint-format-fix.mjs')),
      ).toHaveLength(1);
    });

    it("keeps the user's edited variant rather than the kit's stock command", () => {
      const { merged } = mergeSettings(editedExisting, KIT_FRAGMENT);
      const stopCommands = merged.hooks!.Stop!.flatMap((g) =>
        g.hooks.map((h) => h.command),
      );
      expect(stopCommands[0]).toContain('--my-extra-flag');
    });

    it('does not record a change for a script the user already has', () => {
      const { changes } = mergeSettings(editedExisting, KIT_FRAGMENT);
      expect(changes.some((c) => c.detail.includes('lint-format-fix'))).toBe(
        false,
      );
    });
  });

  describe('upgrading a historical stock command', () => {
    const GUARDED_FRAGMENT: SettingsFragment = {
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [
              {
                type: 'command',
                command:
                  '[ -f "$CLAUDE_PROJECT_DIR/.claude/scripts/guard-bash.mjs" ] && exec node "$CLAUDE_PROJECT_DIR/.claude/scripts/guard-bash.mjs" || echo "[kit] guard-bash.mjs missing — run: npx agent-kit update"',
              },
            ],
          },
        ],
      },
    };
    const unedited: Settings = {
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [
              {
                type: 'command',
                command:
                  'node "$CLAUDE_PROJECT_DIR/.claude/scripts/guard-bash.mjs"',
              },
            ],
          },
        ],
      },
    };
    const edited: Settings = {
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [
              {
                type: 'command',
                command:
                  'node "$CLAUDE_PROJECT_DIR/.claude/scripts/guard-bash.mjs" --extra',
              },
            ],
          },
        ],
      },
    };

    it('replaces its own unedited stock command with the new guarded variant, without duplicating the entry', () => {
      const { merged } = mergeSettings(unedited, GUARDED_FRAGMENT);
      const commands = merged.hooks!.PreToolUse!.flatMap((g) =>
        g.hooks.map((h) => h.command),
      );
      expect(commands).toHaveLength(1);
      expect(commands[0]).toMatch(/^\[ -f /);
    });

    it('records a change noting the upgrade', () => {
      const { changes } = mergeSettings(unedited, GUARDED_FRAGMENT);
      expect(changes.some((c) => c.detail.includes('upgraded'))).toBe(true);
    });

    it('is a no-op when the command is already guarded', () => {
      const first = mergeSettings({}, GUARDED_FRAGMENT);
      const second = mergeSettings(first.merged, GUARDED_FRAGMENT);
      expect(second.changes).toHaveLength(0);
      expect(JSON.stringify(second.merged)).toBe(JSON.stringify(first.merged));
    });

    it('leaves a user-edited variant of the same basename unchanged, without upgrading it', () => {
      const { merged } = mergeSettings(edited, GUARDED_FRAGMENT);
      const commands = merged.hooks!.PreToolUse!.flatMap((g) =>
        g.hooks.map((h) => h.command),
      );
      expect(commands).toHaveLength(1);
      expect(commands[0]).toContain('--extra');
    });

    it('does not record a change when leaving a user edit untouched', () => {
      const { changes } = mergeSettings(edited, GUARDED_FRAGMENT);
      expect(changes.some((c) => c.detail.includes('guard-bash'))).toBe(false);
    });

    it('never disturbs an unrelated hook in the same matcher group during an upgrade', () => {
      const withUnrelatedHook: Settings = {
        hooks: {
          PreToolUse: [
            {
              matcher: 'Bash',
              hooks: [
                {
                  type: 'command',
                  command:
                    'node "$CLAUDE_PROJECT_DIR/.claude/scripts/guard-bash.mjs"',
                },
                { type: 'command', command: 'node ./my-own-hook.js' },
              ],
            },
          ],
        },
      };
      const { merged } = mergeSettings(withUnrelatedHook, GUARDED_FRAGMENT);
      const commands = merged.hooks!.PreToolUse!.flatMap((g) =>
        g.hooks.map((h) => h.command),
      );
      expect(commands).toContain('node ./my-own-hook.js');
    });
  });
});

describe('parseSettingsText', () => {
  it('throws on corrupt settings text rather than repairing it', () => {
    expect(() => parseSettingsText('{ not json')).toThrow();
  });
});
