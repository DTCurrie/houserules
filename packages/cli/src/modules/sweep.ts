import type { Action, ModuleGroup } from '@agent-kit/api';
import { skill } from './copy-actions.js';

export const id = 'sweep';
export const title = 'Sharded mechanical sweep (/sweep)';
export const group: ModuleGroup = 'optional';

export function hint(): string {
  return 'fan a repo-wide rote edit into per-package writers reporting only counts — O(shards), not O(matches)';
}

export function defaultEnabled(): boolean {
  return false;
}

/**
 * An on-demand skill that shards a repo-wide mechanical edit into package-boundaried
 * low-effort writer subagents. The orchestrator pays O(shards) and never sees the match
 * set or the individual diffs.
 *
 * Script-free, because the value is the locate-once, shard, fan-out, verify discipline
 * that the kit's own generated CLAUDE.md tells agents to follow (CONVENTIONS §9).
 */
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
