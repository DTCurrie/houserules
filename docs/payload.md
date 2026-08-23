# Payload conventions

How to author payload: the scripts, libs, and prose that houserules copies into user repos,
from `packages/cli` and every plugin. Read this before touching any file under a package's
`payload/`.

## Cross-package imports

- **Payload code crosses packages by PACKAGE NAME, and the build rewrites it.** Recorded in
  the decision ledger. Any payload file, script or lib, reaches a shared lib as
  `import { nowIso } from '@houserules/payload/entry-ledger'`, for values and types alike.
  There is one form, not two. The nine shared libs live in the standalone
  `@houserules/payload` package: `backlog-id`, `entry-ledger`, `config`, `ledger-index`,
  `proc`, `workspaces`, `comment-scan`, `findings`, and `markdown-segment`. Anything else
  under `./lib/` is the package's own and stays a relative import.
  - **`houserules-payload` is what makes it safe**, a bin the CLI publishes that each plugin
    runs after its `tsc`. It rewrites those specifiers in the emitted `.mjs` to the relative
    form the flattened `.claude/scripts/` layout needs, and records what it rewrote in
    `payload-dist/payload-imports.json`. Install reads that sidecar and copies each named lib
    from `@houserules/payload`'s own `payload-dist`, so a plugin no longer relies on the
    `core` module happening to ship what its scripts import. A plugin declares nothing and
    cannot forget.
  - **Never let a bare `@houserules/*` specifier reach an emitted `.mjs`.** The payload is a
    copy target, not a dependency: it is copied into a user's repo and runs standalone on
    bare node, on every hook. `payload/__tests__/dependencies.test.ts` fails on a surviving
    specifier, and that test is the guard now, replacing the types-only exports map that used
    to fail such an import at runtime by accident.
  - **A value a lib needs is still passed in.** `readGateInputs(ledgerDirectory, autoSync)`
    is the pattern. The script is the composition root, and a pure lib should not reach for
    config. That is a design rule about coupling, not a resolution limit.
  - The old rule here said a payload lib could not import a CLI lib. That was measured false
    on two packages, and a name collision fails loudly at build with TS2305 rather than
    shadowing silently. Do not reintroduce the prohibition.
- A lib the CLI's OWN scripts import must still be listed in `src/modules/core.ts`'s copy
  manifest. A plugin's cross-package imports are derived from its sidecar instead, so only
  the CLI's own manifest is hand-maintained now.

## Config readers

- Two readers of houserules.config.json, one shape: the CLI validates strictly via zod
  (`packages/api/src/config.ts`), and the payload reads it defensively and
  **dependency-free** (`loadConfigSafe()`). They share only the inferred `HouseConfig` type.
  Never make the payload import zod. `payload/__tests__/dependencies.test.ts` enforces this.

## Prose

- Prose houserules ships (payload skills, agents, rules, templates, and the CLAUDE.md region
  `src/render.ts` generates) follows `packages/plugin-prose/payload/rules/prose-voice.md`:
  plain sentences, no semicolons, no em dash where a period or comma works. Frontmatter
  `description:` fields are the skill-routing signal, so keep every trigger term when
  rewording one.

## Plugin containment

- A plugin's payload actions must resolve inside its OWN package. The repo-root
  `scripts/probe-plugin.mjs` loads a plugin through the real resolver and fails any action
  whose `src` escapes the package directory, which is the failure a build alone will not
  catch.
