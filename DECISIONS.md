# Decisions — repo root

Append-only decision log. Add entries via `.claude/scripts/decision-log.mjs`.

## [CLAUDEKIT-116e0c] The CLI package ships substrate that plugins build on; core owning a data format is an interface, not a dependency

**Decided:** 2026-08-03 · **Status:** accepted
**Chat:** cf671b02-c19e-40a8-8cbb-8cf239ec142c
**Scope:** `packages/cli/payload/scripts`, `packages/cli/src/modules`

**Context.** Splitting claude-kit into a core CLI plus plugins raised the question of where `decisions` belongs. Core's `ledger-inject.mjs` reads `.claude/decisions.log` (`payload/scripts/ledger-inject.mts:150`), so shipping `decisions` as a plugin appeared to leave core parsing a format a plugin owns.

**Decision.** The CLI package may ship modules whose job is to support plugins, including ones several plugins share. Core owning a data FORMAT is core owning an interface. The dependency arrow still points from plugin to core. So the ledger substrate stays in core (`ledger-inject.mjs`, `lib/entry-ledger.mjs`, `lib/backlog-id.mjs`) and `decisions` ships as a plugin that writes a ledger the substrate already reads.

**Rejected alternative.** Keeping `decisions` in core because core already parses its log. That reads the coupling backwards and would drag every future record type into core with it. The other rejected option, splitting `ledger-inject.mjs` so each plugin contributes its own injector, needs a hook-composition mechanism the kit does not have.

**Consequences.** `.claude/scripts/lib/*.mjs` becomes a declared public runtime API for plugin scripts, versioned with the CLI. Four departing scripts already import it and none vendor a copy. `decisions` and `ledger` group into one ledgers plugin rather than a personal catch-all.

**Revisit when** a plugin needs prompt injection for a record type whose shape the substrate cannot express, or when the lib surface changes often enough that versioning it costs more than duplication would.

---
