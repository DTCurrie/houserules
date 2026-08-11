import { definePlugin, scriptPermission } from '@agent-kit/api';
import type { Action, ModuleDef, PluginApi } from '@agent-kit/api';

/**
 * An append-only decision ledger, plus the skill that captures a decision and the reviewer
 * that gut-checks it. The rendered `DECISIONS.md` surfaces are deliberately NOT auto-loaded:
 * the log grows without bound and never retires, which is the profile CONVENTIONS §1 warns
 * against. A decision reaches an agent through the skill, the reviewer, or an id in a prompt.
 */
function decisionsModule(api: PluginApi): ModuleDef {
  const id = 'decisions';
  return {
    id,
    title: 'Decision log (/decide + decision-reviewer)',
    group: 'optional',
    hint(): string {
      return 'records durable decisions to disk instead of losing them to context';
    },
    defaultEnabled(): boolean {
      return false;
    },
    plan(): Action[] {
      return [
        api.payload.script(
          id,
          'decision-log.mjs',
          'decision ledger CLI (decide/supersede/amend/show/list/render)',
        ),
        api.payload.skill(
          id,
          'decide',
          'capture a decision, with the recording bar enforced',
        ),
        api.payload.agent(
          id,
          'decision-reviewer',
          'gut-checks a fresh decision record against the bar (haiku)',
        ),
        {
          kind: 'merge-settings',
          module: id,
          fragment: {
            permissions: { allow: [scriptPermission('decision-log.mjs')] },
          },
        },
      ];
    },
  };
}

export default definePlugin((api: PluginApi): ModuleDef[] => [
  decisionsModule(api),
]);
