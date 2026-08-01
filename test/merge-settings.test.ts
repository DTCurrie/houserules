import { expect, test } from 'vitest';

import { mergeSettings, parseSettingsText } from '../src/merge-settings.js';
import type { Settings, SettingsFragment } from '../src/types.js';

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

test('M1: user entries preserved verbatim; kit entries appended', () => {
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
  const { merged, changes } = mergeSettings(existing, KIT_FRAGMENT);
  expect(merged.permissions?.allow?.[0]).toBe('Bash(echo hi)');
  expect(
    merged.permissions?.allow?.includes('Bash(git status:*)'),
  ).toBeTruthy();
  // User hook kept byte-identical, kit hook joined the same matcher group.
  const pre = merged.hooks!.PreToolUse;
  expect(pre.length).toBe(1);
  expect(pre[0].hooks[0].command).toBe('node   ./my-hook.js   --check');
  expect(pre[0].hooks[1].command.includes('guard-bash.mjs')).toBeTruthy();
  expect(merged.otherKey).toEqual({ untouched: true });
  expect(changes.length).toBe(4); // 2 permissions + 2 hooks
});

test('M2: merge is idempotent (double-merge → zero changes, byte-identical)', () => {
  const first = mergeSettings({}, KIT_FRAGMENT);
  const second = mergeSettings(first.merged, KIT_FRAGMENT);
  expect(second.changes.length).toBe(0);
  expect(JSON.stringify(second.merged)).toBe(JSON.stringify(first.merged));
});

test("M2b: a user's EDITED variant of a kit hook wins (script-identity dedupe)", () => {
  const existing: Settings = {
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
  const { merged, changes } = mergeSettings(existing, KIT_FRAGMENT);
  const stopCommands = merged.hooks!.Stop!.flatMap((g) =>
    g.hooks.map((h) => h.command),
  );
  expect(
    stopCommands.filter((c) => c.includes('lint-format-fix.mjs')).length,
  ).toBe(1);
  expect(stopCommands[0].includes('--my-extra-flag')).toBeTruthy();
  expect(
    !changes.some((c) => c.detail.includes('lint-format-fix')),
  ).toBeTruthy();
});

test('M4: corrupt settings text throws (never repaired)', () => {
  expect(() => parseSettingsText('{ not json')).toThrow();
});
