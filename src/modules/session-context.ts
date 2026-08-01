// session-context module (claude-kit CLI): a SessionStart hook that prints a
// 3-line orientation header (branch, changed files, affected targets) so the
// agent stops re-deriving it with full `git status` calls.

import type { Action, ModuleGroup } from '../types.js';
import { hookFragment, script } from './shared.js';

export const id = 'session-context';
export const title = 'Session-start context header';
export const group: ModuleGroup = 'recommended';

export function hint(): string {
  return 'branch + changed files injected at session start';
}

export function defaultEnabled(): boolean {
  return true;
}

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
