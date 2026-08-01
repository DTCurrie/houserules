// sweep module (claude-kit CLI): OPT-IN /sweep skill.
// Ships /sweep, an on-demand skill that shards a repo-wide mechanical edit into
// package-boundaried low-effort writer subagents — the orchestrator pays O(shards),
// never sees the match set or individual diffs. Script-free: the value is the
// locate-once → shard → fan-out → verify discipline, which the kit's own generated
// CLAUDE.md already instructs agents to do but never packaged (CONVENTIONS §8).

import type { Action, ModuleGroup } from '../types.js';
import { skill } from './shared.js';

export const id = 'sweep';
export const title = 'Sharded mechanical sweep (/sweep)';
export const group: ModuleGroup = 'optional';

export function hint(): string {
  return 'fan a repo-wide rote edit into per-package writers reporting only counts — O(shards), not O(matches)';
}

export function defaultEnabled(): boolean {
  return false;
}

export function plan(): Action[] {
  return [
    skill(
      id,
      'sweep',
      'shard a repo-wide mechanical edit into per-package low-effort writers',
    ),
    {
      kind: 'advise',
      text: 'Mechanical repo-wide edits: run /sweep "<change>" to shard the edit into per-package writers (the orchestrator sees only counts, never the match set).',
      module: id,
    },
  ];
}
