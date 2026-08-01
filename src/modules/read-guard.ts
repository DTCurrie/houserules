// read-guard module (claude-kit CLI): OPT-IN PreToolUse(Read) guard.
// Wires guard-read.mjs, which exit-2 redirects only UNBOUNDED whole-file reads of
// generated/oversized files (lockfiles, dist, *.min.*, > maxBytes) toward a targeted
// read or grep — reads carrying offset/limit pass untouched. Enforces the marketed-
// but-unenforced "grep, don't read whole" rule (README, CONVENTIONS §7). Same exit-2
// block contract as guard-bash (a shipped, working PreToolUse guard).

import type { Action, ModuleGroup } from '../types.js';
import { hookFragment, script } from './shared.js';

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
