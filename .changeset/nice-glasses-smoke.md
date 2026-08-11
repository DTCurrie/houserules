---
'@agent-kit/api': minor
---

Initial release. The contract an agent-kit plugin codes against, split out of the installer.

Holds the plugin API, the action union, the module definition, the settings shapes, and the
`kit.config.json` schema. A plugin depends on this rather than on `@agent-kit/cli`, so the installer
stays out of its dependency graph. `definePlugin` types a plugin's default export, and `PluginApi`
hands it action builders already rooted at its own `payload-dist/`, so a plugin resolves no paths of
its own.

Nothing here writes. `apply`, the filesystem target, and the plan engine are not reachable from this
package. A plugin declares actions and the kit decides what they mean against the real tree, which is
the invariant the dry-run story rests on.

Two entry points. `@agent-kit/api` is the plugin contract and is the one to import.
`@agent-kit/api/internal` exists so the installer can reach shared code across the package boundary,
and is not a stable surface.
