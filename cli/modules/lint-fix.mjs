// lint-fix module (claude-kit CLI): Stop/SubagentStop hook that auto-fixes
// lint/format on changed packages and surfaces only the unfixable residue.
//
// Both events stay wired, but the script no-ops on SubagentStop unless
// `fix.onSubagentStop` is true — with parallel subagents each one would fix every
// changed package concurrently. Wiring it anyway keeps the knob a config edit rather
// than a re-run of `update`.

import { hookFragment, script } from './shared.mjs';

export const id = 'lint-fix';
export const title = 'Lint/format auto-fix on Stop';
export const group = 'recommended';

export function hint(ctx) {
  const detected = ctx.targets.filter((t) => t.fixCommands);
  return detected.length
    ? `fix scripts found: ${detected.map((t) => `${t.name} → ${t.fixCommands.join('+')}`).join(', ')}`
    : 'no fix scripts detected — configure fixCommands before enabling';
}

export function defaultEnabled(ctx) {
  return ctx.targets.some((t) => t.fixCommands);
}

export function plan(ctx, answers) {
  const actions = [
    script(
      id,
      'lint-format-fix.mjs',
      'Stop hook: run fix commands on changed packages',
    ),
  ];

  // Wire the Stop/SubagentStop hooks ONLY when a target has a real detected fix
  // command. config.fix.commands is always seeded, so wiring off that would run
  // nonexistent lint:fix/format:fix and spill package-manager errors into context on
  // every turn boundary. Gate on the target fixCommands; advise otherwise.
  const targets = answers?.targets ?? ctx?.targets ?? [];
  const anyFix = targets.some((t) => t.fixCommands?.length);
  if (anyFix) {
    for (const event of ['Stop', 'SubagentStop'])
      actions.push({
        kind: 'merge-settings',
        module: id,
        fragment: hookFragment(
          event,
          null,
          'lint-format-fix.mjs',
          'Running lint/format auto-fix',
        ),
      });
  } else {
    actions.push({
      kind: 'advise',
      text: 'lint-fix is enabled but no target has a detected fix command — the Stop hooks were NOT wired (they would run nonexistent lint:fix/format:fix and spill errors every turn). Add "fixCommands": ["lint:fix", …] to a target in .claude/kit.config.json (with the matching package.json scripts), then run npx claude-kit update to wire them.',
      module: id,
    });
  }
  return actions;
}
