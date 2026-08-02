import type { Action } from '../actions.js';
import type { ModuleGroup } from '../module-def.js';
import { agent, script, skill } from './copy-actions.js';
import { scriptPermission } from './hook-wiring.js';

export const id = 'decisions';
export const title = 'Decision log (/decide + decision-reviewer)';
export const group: ModuleGroup = 'optional';

export function hint(): string {
  return 'records durable decisions to disk instead of losing them to context';
}

export function defaultEnabled(): boolean {
  return false;
}

/**
 * An append-only decision ledger, plus the skill that captures a decision and the reviewer
 * that gut-checks it. The rendered `DECISIONS.md` surfaces are deliberately NOT auto-loaded:
 * the log grows without bound and never retires, which is the profile CONVENTIONS §1 warns
 * against. A decision reaches an agent through the skill, the reviewer, or an id in a prompt.
 */
export function plan(): Action[] {
  return [
    script(
      id,
      'decision-log.mjs',
      'decision ledger CLI (decide/supersede/amend/show/list/render)',
    ),
    skill(id, 'decide', 'capture a decision, with the recording bar enforced'),
    agent(
      id,
      'decision-reviewer',
      'gut-checks a fresh decision record against the bar (haiku)',
    ),
    {
      kind: 'merge-settings',
      module: id,
      fragment: {
        permissions: { allow: [scriptPermission('decision-log.mjs')] },
      },
    },
  ];
}
