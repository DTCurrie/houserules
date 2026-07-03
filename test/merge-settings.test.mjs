import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mergeSettings, parseSettingsText } from '../cli/merge-settings.mjs';

const KIT_FRAGMENT = {
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
  const existing = {
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
  assert.equal(merged.permissions.allow[0], 'Bash(echo hi)');
  assert.ok(merged.permissions.allow.includes('Bash(git status:*)'));
  // User hook kept byte-identical, kit hook joined the same matcher group.
  const pre = merged.hooks.PreToolUse;
  assert.equal(pre.length, 1);
  assert.equal(pre[0].hooks[0].command, 'node   ./my-hook.js   --check');
  assert.ok(pre[0].hooks[1].command.includes('guard-bash.mjs'));
  assert.deepEqual(merged.otherKey, { untouched: true });
  assert.equal(changes.length, 4); // 2 permissions + 2 hooks
});

test('M2: merge is idempotent (double-merge → zero changes, byte-identical)', () => {
  const first = mergeSettings({}, KIT_FRAGMENT);
  const second = mergeSettings(first.merged, KIT_FRAGMENT);
  assert.equal(second.changes.length, 0);
  assert.equal(JSON.stringify(second.merged), JSON.stringify(first.merged));
});

test("M2b: a user's EDITED variant of a kit hook wins (script-identity dedupe)", () => {
  const existing = {
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
  const stopCommands = merged.hooks.Stop.flatMap((g) =>
    g.hooks.map((h) => h.command),
  );
  assert.equal(
    stopCommands.filter((c) => c.includes('lint-format-fix.mjs')).length,
    1,
  );
  assert.ok(stopCommands[0].includes('--my-extra-flag'));
  assert.ok(!changes.some((c) => c.detail.includes('lint-format-fix')));
});

test('M4: corrupt settings text throws (never repaired)', () => {
  assert.throws(() => parseSettingsText('{ not json'));
});
