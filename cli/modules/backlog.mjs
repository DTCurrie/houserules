// backlog module (claude-kit CLI): append-only ledger for out-of-scope work
// (BACKLOG.md + JSONL log), the /backlog-add skill, and the reviewer agent.

import { agent, script, scriptPermission, skill } from './shared.mjs';

export const id = 'backlog';
export const title = 'Backlog ledger (/backlog-add + reviewer agent)';
export const group = 'recommended';

export function hint() {
  return 'log deferred work to disk instead of context';
}

export function defaultEnabled() {
  return true;
}

export function plan() {
  return [
    script(
      id,
      'backlog-log.mjs',
      'backlog ledger CLI (add/remove/update/show/list)',
    ),
    skill(
      id,
      'backlog-add',
      'log an out-of-scope discovery, then gut-check it',
    ),
    agent(id, 'backlog-reviewer', 'validates fresh backlog entries (haiku)'),
    {
      kind: 'merge-settings',
      module: id,
      fragment: {
        permissions: { allow: [scriptPermission('backlog-log.mjs')] },
      },
    },
  ];
}
