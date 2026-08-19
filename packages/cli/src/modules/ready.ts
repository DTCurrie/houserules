import type { Action, ModuleGroup } from '@houserules/api';
import { skill } from './copy-actions.js';

export const id = 'ready';
export const title = 'Pre-handoff roll-up (/ready)';
export const group: ModuleGroup = 'optional';

export function hint(): string {
  return 'one ready/not-ready verdict + acceptance checklist before handoff (pairs with verify-changed + reviewers)';
}

export function defaultEnabled(): boolean {
  return false;
}

/**
 * A read-only, off-context skill that rolls the deterministic pre-handoff checks into one
 * ready or not-ready verdict plus the acceptance checklist, and flags backlog items that
 * were resolved but not removed.
 *
 * Script-free, because the value is the checklist discipline and the delegation to
 * /verify-changed and /review-change. Best paired with those two modules, and degrades
 * gracefully without them.
 */
export function plan(): Action[] {
  return [
    skill(
      id,
      'ready',
      'off-context pre-handoff verdict + acceptance checklist + backlog-resolved check',
    ),
    {
      kind: 'advise',
      text: 'Pre-handoff: run /ready for one ready/not-ready verdict + the acceptance checklist. Best with verify-changed and reviewers enabled (it delegates to them).',
      module: id,
    },
  ];
}
