import { definePlugin, scriptPermission } from '@agent-kit/cli/plugin';
import type { Action, ModuleDef, PluginApi } from '@agent-kit/cli/plugin';

/** An append-only ledger for out-of-scope work, plus the skill and reviewer around it. */
function backlogModule(api: PluginApi): ModuleDef {
  const id = 'backlog';
  return {
    id,
    title: 'Backlog ledger (/backlog-add + reviewer agent)',
    group: 'optional',
    hint(): string {
      return 'log deferred work to disk instead of context';
    },
    defaultEnabled(): boolean {
      return false;
    },
    plan(): Action[] {
      return [
        api.payload.script(
          id,
          'backlog-log.mjs',
          'backlog ledger CLI (add/remove/update/show/list)',
        ),
        api.payload.skill(
          id,
          'backlog-add',
          'log an out-of-scope discovery, then gut-check it',
        ),
        api.payload.agent(
          id,
          'backlog-reviewer',
          'validates fresh backlog entries (haiku)',
        ),
        {
          kind: 'merge-settings',
          module: id,
          fragment: {
            permissions: { allow: [scriptPermission('backlog-log.mjs')] },
          },
        },
      ];
    },
  };
}

export default definePlugin((api: PluginApi): ModuleDef[] => [
  backlogModule(api),
]);
