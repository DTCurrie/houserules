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

const GUARDED_FRAGMENT: SettingsFragment = {
  hooks: {
    PreToolUse: [
      {
        matcher: 'Bash',
        hooks: [
          {
            type: 'command',
            command:
              '[ -f "$CLAUDE_PROJECT_DIR/.claude/scripts/guard-bash.mjs" ] && exec node "$CLAUDE_PROJECT_DIR/.claude/scripts/guard-bash.mjs" || echo "[kit] guard-bash.mjs missing — run: npx claude-kit update"',
          },
        ],
      },
    ],
  },
};

test('M5: the kit upgrades its own historical stock command in place', () => {
  const existing: Settings = {
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
  const { merged, changes } = mergeSettings(existing, GUARDED_FRAGMENT);
  const commands = merged.hooks!.PreToolUse!.flatMap((g) =>
    g.hooks.map((h) => h.command),
  );
  expect(commands).toHaveLength(1);
  expect(commands[0]).toMatch(/^\[ -f /);
  expect(changes.some((c) => c.detail.includes('upgraded'))).toBeTruthy();
});

test('M6: a user-edited variant of the same basename is left untouched (no upgrade)', () => {
  const existing: Settings = {
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
  const { merged, changes } = mergeSettings(existing, GUARDED_FRAGMENT);
  const commands = merged.hooks!.PreToolUse!.flatMap((g) =>
    g.hooks.map((h) => h.command),
  );
  expect(commands).toHaveLength(1);
  expect(commands[0]).toContain('--extra');
  expect(changes.some((c) => c.detail.includes('guard-bash'))).toBeFalsy();
});

test('M7: an already-guarded command is a no-op on re-merge', () => {
  const first = mergeSettings({}, GUARDED_FRAGMENT);
  const second = mergeSettings(first.merged, GUARDED_FRAGMENT);
  expect(second.changes).toHaveLength(0);
  expect(JSON.stringify(second.merged)).toBe(JSON.stringify(first.merged));
});

test("M8: a user's unrelated hook is never disturbed by an upgrade elsewhere", () => {
  const existing: Settings = {
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
  const { merged } = mergeSettings(existing, GUARDED_FRAGMENT);
  const commands = merged.hooks!.PreToolUse!.flatMap((g) =>
    g.hooks.map((h) => h.command),
  );
  expect(commands).toContain('node ./my-own-hook.js');
});
