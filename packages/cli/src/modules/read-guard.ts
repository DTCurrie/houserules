import type { Action, ModuleGroup } from '@agent-kit/api';
import { script } from './copy-actions.js';
import { hookFragment } from '@agent-kit/api';

export const id = 'read-guard';
export const title =
  'Read guard (redirect unbounded reads of generated/huge files)';
export const group: ModuleGroup = 'optional';

export function hint(): string {
  return 'block whole-file Reads of lockfiles/dist/min/oversized files — grep or read a window instead';
}

export function defaultEnabled(): boolean {
  return false;
}

/**
 * A PreToolUse(Read) guard that exit-2 redirects unbounded whole-file reads of generated
 * or oversized files toward a targeted read or a grep. A read carrying offset or limit
 * passes untouched. This enforces the "grep, don't read whole" rule that README and
 * CONVENTIONS §7 otherwise only assert, using the same exit-2 contract as guard-bash.
 */
export function plan(): Action[] {
  return [
    script(
      id,
      'guard-read.mjs',
      'PreToolUse(Read) guard: redirect unbounded reads of generated/oversized files',
    ),
    {
      kind: 'merge-settings',
      module: id,
      fragment: hookFragment('PreToolUse', 'Read', 'guard-read.mjs'),
    },
    {
      kind: 'advise',
      text: 'Read guard on: tune readGuard.maxBytes / readGuard.denyGlobs in .claude/kit.config.json. Reads with offset/limit always pass; only unbounded whole-file reads of generated/huge files are redirected.',
      module: id,
    },
  ];
}
