import { definePlugin, scriptPermission } from '@houserules/api';
import type { Action, ModuleDef, PluginApi } from '@houserules/api';

/**
 * The tool fragment the core scripts read from `.claude/extensions/`. `verify-changed` sets
 * each `shareVariables` entry to a job's share of the script budget, and the changeset gate
 * skips a `package.json` whose only diff sits under a `manifestIgnoreKeys` key, since a wireit
 * block never changes what a consumer of the published tarball observes.
 */
export const WIREIT_EXTENSION = {
  shareVariables: ['WIREIT_PARALLEL'],
  manifestIgnoreKeys: ['wireit'],
} as const;

const EXTENSION_DEST = '.claude/extensions/wireit.json';

/**
 * The base module: the path-scoped wireit rule, plus the fragment that hands wireit's
 * parallelism variable and manifest key to the core scripts. Without the fragment a verify run
 * leaves wireit's own fan-out uncapped inside the script budget.
 */
function wireitModule(api: PluginApi): ModuleDef {
  const id = 'wireit';
  return {
    id,
    title: 'wireit rule and core-script hints (.claude/rules/wireit.md)',
    group: 'optional',
    uses: [
      { id: 'wireit-lint' },
      { id: 'code-cleanliness' },
      { id: 'prose-voice', package: '@houserules/plugin-prose' },
    ],
    hint(): string {
      return 'path-scoped rule for wireit blocks, and WIREIT_PARALLEL under the verify budget';
    },
    defaultEnabled(): boolean {
      return false;
    },
    plan(): Action[] {
      return [
        api.payload.rule(
          id,
          'wireit',
          'path-scoped wireit rule, loaded only when a package.json is in play',
        ),
        {
          kind: 'write',
          dest: EXTENSION_DEST,
          content: `${JSON.stringify(WIREIT_EXTENSION, null, 2)}\n`,
          module: id,
          reason:
            'hands WIREIT_PARALLEL to verify-changed and the wireit key to the changeset gate',
        },
        {
          kind: 'advise',
          text: `wireit rule installed at .claude/rules/wireit.md, path-scoped to package.json files. ${EXTENSION_DEST} tells verify-changed to cap WIREIT_PARALLEL at each job's share of the script budget, and tells the changeset gate that a wireit-only package.json edit is not a release change.`,
          module: id,
        },
      ];
    },
  };
}

/** The mechanical checker over every `package.json` wireit block in the repo. */
function wireitLintModule(api: PluginApi): ModuleDef {
  const id = 'wireit-lint';
  return {
    id,
    title: 'wireit-lint checker (.claude/scripts/wireit-lint.mjs)',
    group: 'optional',
    hint(): string {
      return 'flags wireit blocks with missing scripts, inputs, or node_modules exclusions';
    },
    defaultEnabled(): boolean {
      return false;
    },
    plan(): Action[] {
      return [
        api.payload.script(
          id,
          'wireit-lint.mjs',
          'checks every package.json wireit block against the wireit rule',
        ),
        {
          kind: 'merge-settings',
          module: id,
          fragment: {
            permissions: { allow: [scriptPermission('wireit-lint.mjs')] },
          },
        },
      ];
    },
  };
}

/** The skill that wires one package script into wireit, then runs the checker over it. */
function wireitSetupModule(api: PluginApi): ModuleDef {
  const id = 'wireit-setup';
  return {
    id,
    title: 'wireit setup skill (/wireit-setup)',
    group: 'optional',
    requires: [{ id: 'wireit-lint' }],
    uses: [{ id: 'wireit' }],
    hint(): string {
      return "wires a package's build, check, or test script into wireit";
    },
    defaultEnabled(): boolean {
      return false;
    },
    plan(): Action[] {
      return [
        api.payload.skill(
          id,
          'wireit-setup',
          'wire a package script into wireit, then run wireit-lint over it',
        ),
      ];
    },
  };
}

export default definePlugin((api: PluginApi): ModuleDef[] => [
  wireitModule(api),
  wireitLintModule(api),
  wireitSetupModule(api),
]);
