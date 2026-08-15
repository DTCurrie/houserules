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

## What a plugin gets

`PluginApi` carries three things, all bound to the plugin's own package so it resolves no paths of
its own: `payload`, the action builders rooted at this plugin's `payload-dist/`; `packageName` and
`alias`, its identity and the id namespace its modules are addressed under; and `config`, its slice
of `.claude/houserules.config.json`, verbatim and unvalidated.

Validate that config slice yourself and fail loudly. A plugin that silently accepts a typo'd key is
a plugin whose config does nothing.

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
