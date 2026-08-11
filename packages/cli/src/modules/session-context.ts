import type { Action, ModuleGroup } from '@agent-kit/api';
import { script } from './copy-actions.js';
import { hookFragment } from '@agent-kit/api';

export const id = 'session-context';
export const title = 'Session-start context header';
export const group: ModuleGroup = 'recommended';

export function hint(): string {
  return 'branch + changed files injected at session start';
}

export function defaultEnabled(): boolean {
  return true;
}

/**
 * A SessionStart hook printing a three-line orientation header of branch, changed files,
 * and affected targets, so the agent stops re-deriving it with full `git status` calls.
 */
export function plan(): Action[] {
  return [
    script(
      id,
      'session-context.mjs',
      'SessionStart hook: branch/changes/targets header',
    ),
    {
      kind: 'merge-settings',
      module: id,
      fragment: hookFragment('SessionStart', null, 'session-context.mjs'),
    },
  ];
}
