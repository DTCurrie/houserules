// session-context module (claude-kit CLI): a SessionStart hook that prints a
// 3-line orientation header (branch, changed files, affected targets) so the
// agent stops re-deriving it with full `git status` calls.

import { hookFragment, script } from './shared.mjs';

export const id = 'session-context';
export const title = 'Session-start context header';
export const group = 'recommended';

export function hint() {
  return 'branch + changed files injected at session start';
}

export function defaultEnabled() {
  return true;
}

export function plan() {
  return [
    script(id, 'session-context.mjs', 'SessionStart hook: branch/changes/targets header'),
    {
      kind: 'merge-settings',
      module: id,
      fragment: hookFragment('SessionStart', null, 'session-context.mjs'),
    },
  ];
}
