// ledger module (claude-kit CLI): OPT-IN per-commit JSONL changelog ledger.
// Changesets is the canonical changelog; this exists for repos that also want
// commit-granular history. Its files live under .claude/changelogs/ so it can
// never collide with the CHANGELOG.md that `changeset version` owns.

import { script, scriptPermission } from './shared.mjs';

export const id = 'ledger';
export const title = 'Per-commit changelog ledger (in addition to changesets)';
export const group = 'optional';

export function hint() {
  return 'commit-granular history in .claude/changelogs/ — most repos should rely on changesets alone';
}

export function defaultEnabled() {
  return false;
}

export function plan() {
  return [
    script(
      id,
      'package-changelog.mjs',
      'per-commit ledger (writes .claude/changelogs/)',
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
