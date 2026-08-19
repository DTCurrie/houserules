import type { Action, ModuleGroup } from '@houserules/api';
import { script } from './copy-actions.js';
import { hookFragment } from '@houserules/api';

export const id = 'regen';
export const title = 'Regenerate-on-edit (keep a generated snapshot fresh)';
export const group: ModuleGroup = 'optional';

export function hint(): string {
  return 'PostToolUse hook: re-run a user-owned generator when a matching source file is edited';
}

export function defaultEnabled(): boolean {
  return false;
}

/**
 * A PostToolUse hook that re-runs a user-owned generator when an edited file matches a
 * target's `regen { sourceGlob, command }`, so a reference snapshot stays fresh and
 * grep-able instead of silently staling (CONVENTIONS §7). A generator failure exits 2
 * with the tail, which surfaces it to Claude.
 *
 * The regen blocks themselves live in the user-owned houserules.config.json targets. This module
 * only wires the hook.
 */
export function plan(): Action[] {
  return [
    script(
      id,
      'regen-on-edit.mjs',
      'PostToolUse(Edit|Write|MultiEdit): re-run a matching target.regen generator',
    ),
    {
      kind: 'merge-settings',
      module: id,
      fragment: hookFragment(
        'PostToolUse',
        'Edit|Write|MultiEdit',
        'regen-on-edit.mjs',
      ),
    },
    {
      kind: 'advise',
      text: 'Regen-on-edit on: add a `regen` block to a target in .claude/houserules.config.json — { "sourceGlob": "<glob>", "command": "<generator>" }. Keep the command fast. It runs on every matching edit.',
      module: id,
    },
  ];
}
