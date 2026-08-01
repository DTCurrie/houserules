// statusline module (claude-kit CLI): OPT-IN kit-aware statusLine.
// Ships statusline.mjs and wires it as the statusLine command ONLY when the user has
// none (a single-value merge — never clobber a global statusline). Surfaces the two
// fields the native bar can't: pending changeset debt + kit targets-touched, plus the
// ambient context%/cost from the status JSON.

import type { Action, ModuleGroup } from '../types.js';
import { hookCommand, script } from './shared.js';

export const id = 'statusline';
export const title = 'Kit-aware statusline (changeset debt + targets-touched)';
export const group: ModuleGroup = 'optional';

export function hint(): string {
  return 'opt-in statusLine: pending changeset count + touched kit targets (wired only if you have none)';
}

export function defaultEnabled(): boolean {
  return false;
}

export function plan(): Action[] {
  return [
    script(
      id,
      'statusline.mjs',
      'statusLine command: pending changesets + kit targets-touched + ambient ctx/cost',
    ),
    {
      kind: 'merge-settings',
      module: id,
      // Single-value fragment: set only when the user has no statusLine (merge-settings
      // never overwrites an existing one).
      fragment: {
        statusLine: { type: 'command', command: hookCommand('statusline.mjs') },
      },
    },
    {
      kind: 'advise',
      text: 'Statusline: wired only if you had none. If you keep your own statusLine, call node .claude/scripts/statusline.mjs from it for the pending-changeset + targets-touched fields.',
      module: id,
    },
  ];
}
