// regen module (claude-kit CLI): OPT-IN PostToolUse(Edit|Write|MultiEdit) hook.
// Wires regen-on-edit.mjs, which re-runs a USER-OWNED generator when an edited file
// matches a target's `regen { sourceGlob, command }` — keeping a fragmented-corpus
// reference snapshot fresh and grep-able instead of silently staling (CONVENTIONS §7).
// Exit-2-with-tail on generator failure surfaces it to Claude. The regen blocks live
// in kit.config.json targets (user-owned); this module just wires the hook.

import { hookFragment, script } from './shared.mjs';

export const id = 'regen';
export const title = 'Regenerate-on-edit (keep a generated snapshot fresh)';
export const group = 'optional';

export function hint() {
  return 'PostToolUse hook: re-run a user-owned generator when a matching source file is edited';
}

export function defaultEnabled() {
  return false;
}

export function plan() {
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
      text: 'Regen-on-edit on: add a `regen` block to a target in .claude/kit.config.json — { "sourceGlob": "<glob>", "command": "<generator>" }. Keep the command fast; it runs on every matching edit.',
      module: id,
    },
  ];
}
