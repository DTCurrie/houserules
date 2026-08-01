// backlog module (claude-kit CLI): append-only ledger for out-of-scope work
// (BACKLOG.md + JSONL log), the /backlog-add skill, and the reviewer agent.

import type { Action, ModuleGroup } from '../types.js';
import {
  agent,
  hookFragment,
  script,
  scriptPermission,
  skill,
} from './shared.js';

export const id = 'backlog';
export const title = 'Backlog ledger (/backlog-add + reviewer agent)';
export const group: ModuleGroup = 'recommended';

export function hint(): string {
  return 'log deferred work to disk instead of context';
}

export function defaultEnabled(): boolean {
  return true;
}

export function plan(): Action[] {
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
    // UserPromptSubmit injector: when a prompt names a real backlog ID, inject that
    // entry's decoded record so the model skips a re-derivation round-trip. Inert
    // until a prompt actually references a logged ID. Verified on the stock CLI:
    // UserPromptSubmit exit-0 stdout is added to context (same as SessionStart).
    script(
      id,
      'backlog-inject.mjs',
      'UserPromptSubmit: inject a referenced backlog entry from the log',
    ),
    {
      kind: 'merge-settings',
      module: id,
      fragment: {
        permissions: { allow: [scriptPermission('backlog-log.mjs')] },
        ...hookFragment('UserPromptSubmit', null, 'backlog-inject.mjs'),
      },
    },
  ];
}
