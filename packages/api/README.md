# @houserules/api

The contract an [houserules](https://github.com/DTCurrie/houserules) plugin codes against: the plugin
API, the action types, the module definition, and the `houserules.config.json` schema.

Depend on this rather than on `@houserules/cli`. The CLI is the installer, and a plugin has no reason
to carry it in its dependency graph.

## Install

```sh
pnpm add -D @houserules/api
```

```ts
import { definePlugin } from '@houserules/api';
import type { Action, Ctx, ModuleDef, PluginApi } from '@houserules/api';

export default definePlugin((api: PluginApi): ModuleDef[] => [
  {
    id: 'my-rule',
    title: 'My rule (.claude/rules/my-rule.md)',
    group: 'optional',
    hint: () => 'what this rule covers, in one line',
    defaultEnabled: () => false,
    plan: (_ctx: Ctx): Action[] => [
      api.payload.rule('my-rule', 'my-rule', 'why it installs'),
    ],
  },
]);
```

## Compile with `exactOptionalPropertyTypes`

Compile your plugin with `exactOptionalPropertyTypes: true`. `@houserules/api` exports `HouseConfig` and `HouseConfigTarget` through `Simplify` from `type-fest`, and `type-fest` 6 requires the flag, calling `false` unsupported. houserules itself compiles with the flag on. Existing plugins keep working, but turning it on keeps your types consistent with the ones you import.

## What a plugin gets

`PluginApi` carries three things, all bound to the plugin's own package so it resolves no paths of
its own. `payload` is the action builders rooted at this plugin's `payload-dist/`. `packageName`
and `alias` are its identity and the id namespace its modules are addressed under. `config` is its
slice of `.claude/houserules.config.json`, verbatim and unvalidated.

Validate that config slice yourself and fail loudly. A plugin that silently accepts a typo'd key is
a plugin whose config does nothing.

## Declaring what a module needs

A requirement names another module by its bare id. It is met under any alias, because the alias
is the installing repo's choice.

```ts
import { hasModule } from '@houserules/api';
import type { ModuleDef } from '@houserules/api';

const module: ModuleDef = {
  id: 'my-rule',
  // ...
  requires: [
    { id: 'core' },
    { id: 'design', package: '@houserules/plugin-design' },
  ],
  uses: [{ id: 'reviewers' }],
  options: {
    prompt: 'Which checks?',
    defaults: ['lint'],
    choices: [
      { value: 'lint', label: 'Lint' },
      { value: 'browser', label: 'Browser', requires: [{ id: 'design' }] },
    ],
  },
  skillTriggers: (answers) =>
    hasModule(answers.moduleIds, 'design')
      ? ['- Building UI? Take tokens from the design module.']
      : [],
};
```

`hasModule` answers whether a module is selected under any alias, so `'design'` matches both `design` and `ui-kit/design`.

`requires` is for a module this one cannot do its job without. Selecting the module installs each
requirement, transitively, in `init`, the interactive picker, `update`, and `modules`. The picker
shows a required module locked on and names the requirer. Withdrawing a required module while its
requirer stays selected stops with an error naming both. `doctor` warns when an installed module's
requirement is missing.

A requirement that no installed plugin supplies stops `init` and `update` before anything is
written. The error names the package and its install command. Set `package` on any requirement for
a module outside the CLI, so the error can name it.

`uses` is for a hand-off the module skips correctly when the other module is absent. It installs
nothing. If the module cannot do its job without the hand-off, use `requires`.

A `requires` on an option choice is met only while that value is selected.

Declare every module your plugin's prose names. That covers another module's skill, agent, script,
rule, reference, or output style mentioned in a skill, agent, rule, or template the plugin ships.
Use `requires` when your module cannot work without the named one. Use `uses` when your prose
states what to do in a repo where the named module is absent. An undeclared name reads fine in a
repo that has everything installed and points at nothing in one that does not.

houserules checks this for its own first-party packages only, at build time, against their payload
sources. The check never ships, so it cannot see a third-party plugin's prose. As a third-party
author, you declare your own.

`skillTriggers(answers)` returns bullet lines the module adds to the "Skill triggers" section of
the managed CLAUDE.md region. The CLI calls it only when the module is selected. Read a sibling
module in `answers.moduleIds` by its bare id or by the suffix `/<id>`. A module from another plugin
arrives as `<alias>/<id>` under the alias the installing repo chose, so `${api.alias}/<id>` only
matches your own plugin's modules. `answers.contributedSkillTriggers` holds the collected lines. The CLI fills it, and a module never sets it.

## Handing a tool's specifics to the core scripts

A plugin never edits a core script to teach it about a tool. It installs a fragment at
`.claude/extensions/<plugin>.json` with a `write` action. The core scripts merge every fragment
through `loadExtensionsSafe()`. `shareVariables` names env variables that `verify-changed` sets to
a job's share of the script budget. `manifestIgnoreKeys` names `package.json` keys the changeset
gate skips when they are the only diff. No core script names a build tool.

```ts
plan(): Action[] {
  return [
    {
      kind: 'write',
      dest: '.claude/extensions/my-tool.json',
      content: `${JSON.stringify({ shareVariables: ['MY_TOOL_PARALLEL'], manifestIgnoreKeys: ['myTool'] }, null, 2)}\n`,
      module: 'my-tool',
      reason: 'hands MY_TOOL_PARALLEL and the myTool key to the core scripts',
    },
  ];
}
```

## What it deliberately does not give you

Nothing here writes. `apply`, the filesystem target, and the plan engine are not reachable from this
package. A plugin declares actions and houserules decides what they mean against the real tree, which
is the invariant the whole dry-run story rests on.

`plan()` must be pure. It may read the plugin's own package, but it must not touch the target repo,
spawn a process, or cache across calls. houserules calls it while computing a plan that may never be
applied.

## Two entry points

`@houserules/api` is the plugin contract, and it is the one to import.

`@houserules/api/internal` exists so the installer can reach shared code across the package boundary.
It is not a stable surface and a plugin has no reason to import it. If something you need is only
reachable there, that is a gap in the contract worth
[filing](https://github.com/DTCurrie/houserules/issues).

## Docs

`CONVENTIONS.md` in `@houserules/cli` documents the full plugin contract, including how a plugin's
payload reaches a shared lib.

## Part of houserules

[houserules](https://github.com/DTCurrie/houserules) is portable Claude Code
infrastructure that keeps the agent's context lean. The
[package list](https://github.com/DTCurrie/houserules#packages) has the rest.

## License

MIT
