import {
  definePlugin,
  hookFragment,
  scriptPermission,
} from '@agent-kit/cli/plugin';
import type { Action, ModuleDef, PluginApi } from '@agent-kit/cli/plugin';

/**
 * The plugin's own config slice, which today recognizes nothing.
 *
 * Every setting this plugin has lives at the top level of `kit.config.json`, under `projects`,
 * because the payload scripts are what read them and a script does not know which alias its
 * plugin was declared under. It therefore cannot find its own `plugins[]` entry.
 *
 * @throws When `config` is anything but an object or absent, and specifically when it carries
 *   `autoSync`. That key looks right and does nothing here, so accepting it silently would be a
 *   setting that never takes effect. The message names where it belongs instead.
 */
function readConfig(config: unknown): void {
  if (config === undefined) return;

  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    throw new Error('projects config must be an object');
  }

  for (const key of Object.keys(config as Record<string, unknown>)) {
    if (key === 'autoSync') {
      throw new Error(
        'projects config key "autoSync" belongs at the top level of kit.config.json, as `projects.autoSync`, not inside this plugin\'s `config` block. The scripts read it from there.',
      );
    }
    throw new Error(`projects config has an unknown key "${key}"`);
  }
}

/** Syncs the backlog and decision ledgers to a GitHub Project, so the durable record survives outside the repo. */
function projectsModule(api: PluginApi): ModuleDef {
  const id = 'projects';
  readConfig(api.config);

  return {
    id,
    title: 'GitHub Projects sync (backlog + decision ledgers)',
    group: 'optional',
    hint(): string {
      return 'mirrors the backlog and decision ledgers to a GitHub Project';
    },
    defaultEnabled(): boolean {
      return false;
    },
    plan(): Action[] {
      return [
        api.payload.script(
          id,
          'projects-sync.mjs',
          'syncs the backlog and decision ledgers to a GitHub Project',
        ),
        api.payload.lib(id, 'gh.mjs'),
        api.payload.lib(id, 'sync-gate.mjs'),
        api.payload.lib(id, 'project-shape.mjs'),
        api.payload.lib(id, 'bootstrap-plan.mjs'),
        api.payload.lib(id, 'push-queue.mjs'),
        api.payload.lib(id, 'item-fields.mjs'),
        api.payload.script(
          id,
          'projects-sync-hook.mjs',
          'SessionEnd hook: pushes the ledgers in the background when there is anything to push',
        ),
        api.payload.skill(
          id,
          'ledger-sync',
          'push the ledgers to the boards by hand, and read what is pending',
        ),
        api.payload.skill(
          id,
          'backlog-adopt',
          'adopt a reported GitHub issue into the backlog ledger and onto the project board',
        ),
        {
          kind: 'merge-settings',
          module: id,
          fragment: {
            permissions: { allow: [scriptPermission('projects-sync.mjs')] },
          },
        },
        // No matcher, so it also fires on `/clear` and `/resume`. Those usually follow a chunk
        // of finished work, and a drained queue makes the hook a cheap local no-op, so firing
        // more often costs nothing and keeps the board fresher.
        {
          kind: 'merge-settings',
          module: id,
          fragment: hookFragment('SessionEnd', null, 'projects-sync-hook.mjs'),
        },
      ];
    },
  };
}

export default definePlugin((api: PluginApi): ModuleDef[] => [
  projectsModule(api),
]);
