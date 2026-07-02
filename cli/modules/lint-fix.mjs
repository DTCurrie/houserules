// lint-fix module (claude-kit CLI): Stop/SubagentStop hook that auto-fixes
// lint/format on changed packages and surfaces only the unfixable residue.

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

export function plan() {
  return [
    script(id, 'lint-format-fix.mjs', 'Stop hook: run fix commands on changed packages'),
    {
      kind: 'merge-settings',
      module: id,
      fragment: hookFragment('Stop', null, 'lint-format-fix.mjs', 'Running lint/format auto-fix'),
    },
    {
      kind: 'merge-settings',
      module: id,
      fragment: hookFragment('SubagentStop', null, 'lint-format-fix.mjs', 'Running lint/format auto-fix'),
    },
  ];
}
