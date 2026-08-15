import { runsAtRepoRoot } from '@houserules/payload/config';
import type { Action, Answers, ModuleGroup } from '@houserules/api';
import type { Ctx } from '../detect.js';
import { script } from './copy-actions.js';
import { hookFragment } from '@houserules/api';

export const id = 'lint-fix';
export const title = 'Lint/format auto-fix on Stop';
export const group: ModuleGroup = 'recommended';

/**
 * The top-level `fix.commands` a root-scoped runner block (`filterFlag: ""`) would run,
 * kept to only the ones that actually exist as a root `package.json` script.
 *
 * `config.fix.commands` is always seeded, so its mere presence proves nothing: it is only
 * trustworthy once checked against the root scripts it claims to run.
 */
function rootFixCommands(ctx: Ctx): string[] {
  const fix = ctx.claude.houseConfig?.fix;
  if (!fix?.commands?.length || !runsAtRepoRoot(fix)) return [];
  const scripts = ctx.rootPkg?.scripts ?? {};
  return fix.commands.filter((cmd) => typeof scripts[cmd] === 'string');
}

export function hint(ctx: Ctx): string {
  const detected = ctx.targets.filter((t) => t.fixCommands);
  const parts = detected.map((t) => `${t.name} → ${t.fixCommands!.join('+')}`);
  const root = rootFixCommands(ctx);
  if (root.length) parts.push(`root → ${root.join('+')}`);
  return parts.length
    ? `fix scripts found: ${parts.join(', ')}`
    : 'no fix scripts detected — configure fixCommands before enabling';
}

export function defaultEnabled(ctx: Ctx): boolean {
  return (
    ctx.targets.some((t) => t.fixCommands) || rootFixCommands(ctx).length > 0
  );
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

  // Gate on target fixCommands, or on config.fix.commands once verified against real root
  // scripts (rootFixCommands). Never on config.fix.commands as-is: wiring off the always-
  // seeded default, unchecked, would spill package-manager errors into context every turn.
  const targets = answers?.targets ?? ctx?.targets ?? [];
  const anyFix =
    targets.some((t) => t.fixCommands?.length) ||
    rootFixCommands(ctx).length > 0;
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
      text: 'lint-fix is enabled but no target has a detected fix command — the Stop hooks were NOT wired (they would run nonexistent lint:fix/format:fix and spill errors every turn). Add "fixCommands": ["lint:fix", …] to a target in .claude/houserules.config.json (with the matching package.json scripts), then run npx houserules update to wire them.',
      module: id,
    });
  }
  return actions;
}
