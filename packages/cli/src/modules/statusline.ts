import type { Action, ModuleGroup } from '@agent-kit/api';
import { script } from './copy-actions.js';
import { hookCommand } from '@agent-kit/api';

export const id = 'statusline';
export const title = 'Kit-aware statusline (changeset debt + targets-touched)';
export const group: ModuleGroup = 'optional';

export function hint(): string {
  return 'opt-in statusLine: pending changeset count + touched kit targets (wired only if you have none)';
}

export function defaultEnabled(): boolean {
  return false;
}

/**
 * A kit-aware statusLine surfacing the two fields the native bar cannot: pending
 * changeset debt and kit targets touched, alongside the ambient context percentage and
 * cost from the status JSON. Wired only when the user has no statusLine of their own.
 */
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
      // A single-value fragment, so merge-settings never overwrites an existing one.
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
