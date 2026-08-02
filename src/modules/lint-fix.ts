import type { Action, Answers, Ctx, ModuleGroup } from '../types.js';
import { hookFragment, script } from './shared.js';

export const id = 'lint-fix';
export const title = 'Lint/format auto-fix on Stop';
export const group: ModuleGroup = 'recommended';

export function hint(ctx: Ctx): string {
  const detected = ctx.targets.filter((t) => t.fixCommands);
  return detected.length
    ? `fix scripts found: ${detected.map((t) => `${t.name} → ${t.fixCommands!.join('+')}`).join(', ')}`
    : 'no fix scripts detected — configure fixCommands before enabling';
}

export function defaultEnabled(ctx: Ctx): boolean {
  return ctx.targets.some((t) => t.fixCommands);
}

/**
 * A Stop and SubagentStop hook that auto-fixes lint and format on changed packages and
 * surfaces only the unfixable residue.
 *
 * Both events stay wired, but the script no-ops on SubagentStop unless
 * `fix.onSubagentStop` is true, because parallel subagents would each fix every changed
 * package concurrently. Wiring it anyway keeps that knob a config edit rather than a
 * re-run of `update`.
 */
export function plan(ctx: Ctx, answers: Answers): Action[] {
  const actions: Action[] = [
    script(
      id,
      'lint-format-fix.mjs',
      'Stop hook: run fix commands on changed packages',
    ),
  ];

  // Gate on target fixCommands, never on the always-seeded config.fix.commands. Wiring
  // off the latter would spill package-manager errors into context every turn.
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
