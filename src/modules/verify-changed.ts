import type { Action } from '../actions.js';
import type { Ctx } from '../detect.js';
import type { ModuleGroup } from '../module-def.js';
import { script, skill } from './copy-actions.js';
import { scriptPermission } from './hook-wiring.js';

export const id = 'verify-changed';
export const title = 'Diff-scoped verification (/verify-changed)';
export const group: ModuleGroup = 'optional';

export function hint(ctx: Ctx): string {
  return ctx.isMonorepo
    ? 'run check/test/lint on only the changed packages + their dependents, off-context'
    : 'run verify on the changed repo off-context (best value in a monorepo)';
}

export function defaultEnabled() {
  return false;
}

/**
 * Diff-scoped verification. The helper resolves the changed packages plus their
 * transitive dependents and runs each package's verify commands, returning a compact
 * pass-or-fail-per-package verdict. The skill runs the helper inside a subagent, so a
 * multi-minute full-suite transcript never reaches the main context. Only the verdict
 * does.
 *
 * Config lives in the `verify` block that `render.ts` adds to kit.config.json when this
 * module is enabled.
 */
export function plan(): Action[] {
  return [
    script(
      id,
      'verify-changed.mjs',
      'resolve changed-packages + dependents and run their verify commands',
    ),
    skill(
      id,
      'verify-changed',
      'off-context diff-scoped verification (spawns one subagent, returns only the verdict)',
    ),
    {
      kind: 'merge-settings',
      module: id,
      fragment: {
        permissions: { allow: [scriptPermission('verify-changed.mjs')] },
      },
    },
    {
      kind: 'advise',
      text: 'verify-changed: tune the `verify` block + per-target verifyCommands in .claude/kit.config.json (default command is `verify`), then run /verify-changed before handing off.',
      module: id,
    },
  ];
}
