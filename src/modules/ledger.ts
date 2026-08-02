import type { Action } from '../actions.js';
import type { ModuleGroup } from '../module-def.js';
import { script, template } from './copy-actions.js';
import { scriptPermission } from './hook-wiring.js';

export const id = 'ledger';
export const title = 'Per-commit changelog ledger (in addition to changesets)';
export const group: ModuleGroup = 'optional';

export function hint(): string {
  return 'commit-granular history in .claude/changelogs/ — most repos should rely on changesets alone';
}

export function defaultEnabled(): boolean {
  return false;
}

/**
 * A per-commit JSONL changelog, for repos that want commit-granular history alongside
 * changesets. Its files live under `.claude/changelogs/` so they can never collide with
 * the CHANGELOG.md that `changeset version` owns.
 */
export function plan(): Action[] {
  return [
    script(
      id,
      'package-changelog.mjs',
      'per-commit ledger (writes .claude/changelogs/)',
    ),
    template(
      id,
      'agents/archivist.agent.md.template',
      'ledger archivist pattern',
    ),
    {
      kind: 'merge-settings',
      module: id,
      fragment: {
        permissions: { allow: [scriptPermission('package-changelog.mjs')] },
      },
    },
    {
      kind: 'advise',
      text: 'Ledger: instantiate an archivist per target from .claude/kit-templates/agents/archivist.agent.md.template (records commits into .claude/changelogs/).',
      module: id,
    },
  ];
}
