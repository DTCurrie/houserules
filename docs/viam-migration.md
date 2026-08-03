# Migrating `@viamrobotics/claude-config` to `@claude-kit/cli`

This is an execution plan for replacing the Viam fork of this engine,
`@viamrobotics/claude-config` (`/Users/devin/Projects/viam/prime/packages/claude-config`), with
`@claude-kit/cli` plus one new plugin, `@viamrobotics/claude-kit-plugin` (name TBD). It maps every
asset the fork ships to a claude-kit concept, names what has no home yet, and gives a phased order.

## What the migration buys

claude-kit already solves the two hardest problems the fork's own `CLAUDE.md` names as open:
frontmatter-vs-body ownership on rules (the `body` action), and drift detection plus reconciliation
(`doctor --fix`). The fork reinvented both (`regions.ts`, `drift.ts`) and would otherwise keep
carrying that code. Moving onto claude-kit means Viam's rule set benefits from every fix and
feature claude-kit ships for every other adopter, instead of a fork that only Viam maintains. The
plugin boundary is real: `packages/plugin-prose` and `packages/plugin-testing` are worked
multi-module plugins already shipping, not a hypothetical extension point.

## What it costs

Three fork features have no claude-kit action kind today: the MCP config templates, the CI
workflow pin (`WORKFLOWS_REF` and the `claude-*.yml` stubs), and `settings.ci.json` as a file
distinct from `.claude/settings.json`. `.nvmrc` also has no destination action reachable from a
plugin. None of these are exotic; they are ordinary file writes. But "ordinary file write a plugin
can request" is not yet a thing claude-kit lets a plugin do, because every action kind that writes
today writes into a shape the kit already knows (a rule body, a settings fragment, a script under
`.claude/scripts/`). Landing this migration means either extending claude-kit's action surface
first, or leaving those four assets in the Viam repo's own tooling rather than the plugin. See
Gaps below. Budget for that extension work before promising a full replacement.

## Asset map

| Fork asset                                                                                                                                                 | Source                                                        | claude-kit concept                                                                                                                                                                                                                    |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `templates/rules/go.md`                                                                                                                                    | one static rule                                               | `body` action, plugin module `go`                                                                                                                                                                                                     |
| `templates/rules/svelte.md`                                                                                                                                | one static rule                                               | `body` action, plugin module `svelte`                                                                                                                                                                                                 |
| `templates/rules/three.md`                                                                                                                                 | one static rule                                               | `body` action, plugin module `three`                                                                                                                                                                                                  |
| `templates/rules/typescript.md`                                                                                                                            | one static rule                                               | `body` action, plugin module `typescript`                                                                                                                                                                                             |
| `templates/rules/design-system.md`                                                                                                                         | one static rule                                               | `body` action, plugin module `design-system`                                                                                                                                                                                          |
| `templates/rules/frontend-aesthetics.md`                                                                                                                   | one static rule                                               | `body` action, plugin module `frontend-aesthetics`                                                                                                                                                                                    |
| `templates/rules/editing-discipline.md`                                                                                                                    | one static rule                                               | `body` action, plugin module `editing-discipline`                                                                                                                                                                                     |
| `templates/rules/verification.md`                                                                                                                          | one static rule                                               | `body` action, plugin module `verification`                                                                                                                                                                                           |
| `templates/rules/pr-description.md`                                                                                                                        | one static rule                                               | `body` action, plugin module `pr-description`                                                                                                                                                                                         |
| `templates/rules/changesets.md`                                                                                                                            | one static rule                                               | `body` action, plugin module `changesets` (claude-kit core already ships a `changesets` concept; Viam's variant needs its own module id under the plugin alias, e.g. `viam/changesets`, so it does not collide)                       |
| `templates/rules/testing-go.md`, `templates/rules/testing-frontend.md`                                                                                     | language-specific test guides                                 | `moduleOptions` choices on one `testing`-shaped module, the `@claude-kit/plugin-testing` pattern: one base rule plus opt-in language guides selected via `options.choices` and read back from `answers.moduleOptions['<alias>/<id>']` |
| `templates/output-styles/Terse.md`                                                                                                                         | one output style file                                         | `PayloadBuilders.file()` copy action, the same builder `output-prose` in `packages/plugin-prose` uses                                                                                                                                 |
| `templates/claude/settings.ci.json`                                                                                                                        | a `.claude/settings.ci.json` file                             | **gap**, see below                                                                                                                                                                                                                    |
| `templates/mcp/mcp.http.json`, `templates/mcp/mcp.stdio.json`, `templates/mcp/vscode.mcp.json`                                                             | MCP server config, chosen by manifest's `mcp.svelteTransport` | **gap**, see below                                                                                                                                                                                                                    |
| `templates/hooks/session-start.mjs`                                                                                                                        | opt-in SessionStart hook                                      | `script` copy action plus `merge-settings` with `hookFragment('SessionStart', null, 'session-start.mjs')`, exactly the shape `src/modules/session-context.ts` already uses in claude-kit core                                         |
| `templates/scaffold/gitignore-block.txt`                                                                                                                   | managed `.gitignore` block                                    | `region` action against `.gitignore`, the same shape claude-kit's `prettier-guard` module uses for `.prettierignore`                                                                                                                  |
| `templates/scaffold/prettierignore-block.txt`                                                                                                              | managed `.prettierignore` block                               | `region` action, same as above                                                                                                                                                                                                        |
| `templates/rules/viam-context.md.tmpl`                                                                                                                     | rendered from `viamContext.sources`, per-repo                 | **not a static file.** See the dedicated section below.                                                                                                                                                                               |
| `.nvmrc`                                                                                                                                                   | one static file, node version pinned in the manifest          | **gap**, see below                                                                                                                                                                                                                    |
| `WORKFLOWS_REF` + `claude-*.yml` caller-stubs + `weekly-dependency-update.yml`                                                                             | CI workflow files rendered from a pinned SHA                  | **gap**, see below. Also worth noting: the fork's own `CLAUDE.md` says these emit nothing yet, so this gap exists on both sides today.                                                                                                |
| `src/core/manifest.ts` schema fields (`repo.name`, `repo.nodeVersion`, `rules.modules`, `mcp.svelteTransport`, `outputStyle.terse`, `viamContext.sources`) | zod schema, Viam-specific                                     | the plugin's `config` key in `.claude/kit.config.json`, validated by the plugin itself, not by claude-kit's `KitConfigSchema`                                                                                                         |

## Gaps: what claude-kit cannot express yet

Checked against `packages/cli/src/actions.ts`. The `Action` union has seven kinds: `copy`,
`write`, `seed`, `region`, `body`, `merge-settings`, `advise`. Every one of them writes into a
shape the kit already understands: a plain file copy, a generated file, a user-owned seed, a
marker region inside a host file, a rule's body under fixed frontmatter, a settings.json
fragment, or a checklist line. None of them is "write an arbitrary JSON or YAML file at an
arbitrary path that the kit fully owns and refreshes on every `update`," which is what four fork
assets need.

- **`.nvmrc`.** A single line, kit-owned, refreshed from the manifest's node version. The closest
  existing kind is `write` (`WriteAction`, generated content) or `copy` (`CopyAction`, static
  payload file), and both already exist as manifest-tracked, refreshable actions. In principle a
  plugin can already build a `write` action for this today: `write` is not restricted to
  `.claude/`. Confirm that claude-kit's manifest and prune logic treat a `write` action at a
  repo-root destination like `.nvmrc` the same as one under `.claude/`, since every other module
  in the codebase only ever writes there. If it does, `.nvmrc` is not actually a gap, it is an
  unexercised path. Verify before relying on it.

- **`templates/claude/settings.ci.json`.** A JSON file distinct from `.claude/settings.json`, so
  `merge-settings` (which only folds a fragment into `.claude/settings.json`) does not apply. A
  `write` action can place it, but nothing in claude-kit today reads or reconciles a _second_
  settings file the way `merge-settings` reconciles `settings.json` fragments from multiple
  modules. If only Viam's plugin ever writes to `settings.ci.json`, a plain `write` action is
  sufficient and this may not be a gap. If more than one module needs to contribute to it,
  claude-kit needs a `merge-settings`-shaped mechanism for a second target file, which does not
  exist.

- **MCP config (`templates/mcp/mcp.http.json`, `mcp.stdio.json`, `vscode.mcp.json`).** These are
  chosen by a config value (`mcp.svelteTransport`) and go to `.mcp.json` and `.vscode/mcp.json`.
  A plugin can build the JSON content itself (transport choice lives in its own `config`, which
  the kit never inspects) and emit it via `write`. The gap is not "can a plugin write JSON," it is
  that claude-kit has no first-class "one of several template variants selected by config" helper.
  Every plugin that needs this builds the branching by hand. Workable, not blocked.

- **CI workflow stubs and `WORKFLOWS_REF`.** The fork's own `CLAUDE.md` admits these are validated
  but unimplemented on the fork side too: "The manifest's `ci`, `verify`, and `workflows` sections
  are validated but emit nothing yet." So this is not a claude-kit regression, it is unported
  functionality on both sides. When it lands, the caller-stub `.github/workflows/claude-*.yml`
  files are ordinary `write` actions (their content is rendered by the plugin, not templated by
  the kit), and the SHA pin (`WORKFLOWS_REF`) is a plugin-owned constant, not a kit concept at
  all. No kit-side gap here beyond "nobody has written the plugin code yet."

None of the four items above blocks the rules-and-hooks slice of the migration. They block a
byte-for-byte parity claim. Do not promise parity until `.nvmrc` is confirmed as a genuine
non-gap and `settings.ci.json` ownership (single-writer vs. multi-writer) is decided.

## `viam-context.md.tmpl`: config, not a file

The fork's own `CLAUDE.md` calls this file the **one exception** to "rules are static": its
source table is rendered per-repo from `viamContext.sources` in the manifest, not copied
byte-for-byte like every other rule. That per-repo variability is exactly what a plugin's `config`
key is for: `PluginApi.config` is "this plugin's slice of `.claude/kit.config.json`, verbatim and
unvalidated," and the plugin is the one place that both owns the render logic and can read the
per-repo source list.

Concretely: the plugin's `plan()` reads `api.config` for `viamContext.sources`, builds the
rendered markdown itself (in TypeScript, the same "no template loops" discipline the fork already
follows for its micro-renderer), and emits it as a `write` action rather than a `body` or `copy`
action, because there is no static payload file to hash against. `write`'s content is the fully
rendered string, module-attributed and manifest-tracked the same as any other generated file. It
does not become a `body` action because `body` splits frontmatter you own from a body the kit
ships unchanged, and this file's _body_ itself is the part that varies per repo.

## Phased order

1. **Prove the seam with one static rule first.** Port `templates/rules/typescript.md` alone as a
   `body` action in a new plugin skeleton. This exercises the full path — plugin package layout,
   `payload/rules/`, `PayloadBuilders.rule()`, alias namespacing in `.claude/kit.config.json` —
   with the lowest-risk asset, since a `body` action is exactly what claude-kit already tests
   against in `packages/plugin-testing`.
2. **Port the rest of the static rules** (`go`, `svelte`, `three`, `design-system`,
   `frontend-aesthetics`, `editing-discipline`, `verification`, `pr-description`, `changesets`)
   the same way, one module or one `moduleOptions`-grouped module each.
3. **Port the language test guides** (`testing-go.md`, `testing-frontend.md`) as `moduleOptions`
   choices on one testing-shaped module, following `packages/plugin-testing/src/index.ts`
   directly: same `options.choices` / `answers.moduleOptions['<alias>/<id>']` shape.
4. **Port the output style and the two managed-ignore blocks** (`Terse.md` via `file()`,
   `gitignore-block.txt` and `prettierignore-block.txt` via `region` actions). Low risk, no
   config dependency.
5. **Port the SessionStart hook** (`templates/hooks/session-start.mjs`) via `script()` +
   `merge-settings` with `hookFragment('SessionStart', ...)`. This is the first asset that needs
   the zero-dependency, bare-node execution bar claude-kit enforces on all payload scripts
   (`payload/__test__/execution.test.ts` equivalent in the plugin's own test suite); the fork's
   hook already meets that bar (`node:child_process` only), so this should port with no rewrite.
6. **Build `viam-context.md.tmpl` as a config-driven `write` action.** This is the first asset that
   depends on the plugin's `config` shape being finalized, so it comes after the static assets
   prove the alias and packaging story works.
7. **Land the `.nvmrc`, `settings.ci.json`, and MCP config writes last**, once the open questions
   above (root-level `write` destinations, single- vs. multi-writer settings files) are answered.
   Do not port the CI workflow stubs and `WORKFLOWS_REF` at all until that functionality exists on
   the fork side, since porting unimplemented functionality only relocates the TODO.

## What stays in the Viam repo permanently

The plugin package itself (`@viamrobotics/claude-kit-plugin` or similar) stays a Viam-owned repo,
not a claude-kit package, because its rule content (Go, Svelte, Three.js, Viam's design system)
is Viam-specific and has no reason to live upstream. The manifest schema for `viamContext.sources`
and any other Viam-only config shape stays plugin-owned and validated by the plugin, never folded
into claude-kit's `KitConfigSchema`, per the `config` key's own contract: "the kit never looks
inside it." The `claude-*.yml` CI workflow stubs and the `WORKFLOWS_REF` pin, once implemented,
stay Viam-owned too: they reference a Viam-internal repo (`claude-ci-workflows`) that has no
claude-kit equivalent and no reason to gain one.
