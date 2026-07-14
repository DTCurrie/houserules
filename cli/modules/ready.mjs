// ready module (claude-kit CLI): OPT-IN pre-handoff roll-up skill.
// Ships /ready, a read-only, off-context skill that rolls the deterministic
// pre-handoff checks into ONE ready/not-ready verdict + the acceptance checklist,
// and flags backlog items resolved-but-not-removed. Script-free: the value is the
// checklist discipline + delegation to /verify-changed and /review-change, not
// tooling. Best paired with those two modules, but degrades gracefully without them.

import { skill } from './shared.mjs';

export const id = 'ready';
export const title = 'Pre-handoff roll-up (/ready)';
export const group = 'optional';

export function hint() {
  return 'one ready/not-ready verdict + acceptance checklist before handoff (pairs with verify-changed + reviewers)';
}

export function defaultEnabled() {
  return false;
}

export function plan() {
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
