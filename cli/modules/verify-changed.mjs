// verify-changed module (claude-kit CLI): OPT-IN diff-scoped verification.
// Ships the /verify-changed skill + verify-changed.mjs helper, which resolves the
// changed packages PLUS their transitive dependents and runs each package's verify
// commands, returning a compact PASS/FAIL-per-package verdict. The skill runs the
// helper INSIDE a subagent so a multi-minute full-suite transcript never reaches the
// main context — only the verdict does. Config lives in the `verify` block that
// render.mjs adds to kit.config.json when this module is enabled.

import { script, scriptPermission, skill } from './shared.mjs';

export const id = 'verify-changed';
export const title = 'Diff-scoped verification (/verify-changed)';
export const group = 'optional';

export function hint(ctx) {
  return ctx.isMonorepo
    ? 'run check/test/lint on only the changed packages + their dependents, off-context'
    : 'run verify on the changed repo off-context (best value in a monorepo)';
}

export function defaultEnabled() {
  return false;
}

export function plan() {
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
