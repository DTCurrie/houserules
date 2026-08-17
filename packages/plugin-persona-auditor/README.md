# @houserules/plugin-persona-auditor

[![npm](https://img.shields.io/npm/v/@houserules/plugin-persona-auditor.svg)](https://www.npmjs.com/package/@houserules/plugin-persona-auditor)

An agent asked to check whether a system's choice serves a given persona will read the
selection code first if you let it, and then rationalize whatever that code already decided.
That check confirms the engine's own logic instead of testing it against the persona.

This plugin ships a template for an agent that ranks blind before it looks: it forms its own
ranking from a persona's stated priorities and the option data alone, only then reveals what
the system actually chose, and buckets any divergence by a typed cause instead of guessing at
it. It is a template you instantiate per component, not a module that installs standalone.

If your install carries a `persona-auditor` module id from before the CLI's built-in modules
moved into plugins, install this package to restore it under its plugin id.

## Install

```
pnpm add -D @houserules/plugin-persona-auditor
pnpm exec houserules init
```

Requires [`@houserules/cli`](https://github.com/DTCurrie/houserules/tree/main/packages/cli).
`init` is what writes the module into `.claude/`. This module is off by default, so select it
when `init` asks.

## Modules

- **`persona-auditor`** installs
  `.claude/templates/agents/persona-auditor.agent.md.template`, a read-only,
  haiku-model agent template. Fill in `<COMPONENT>`, `<PERSONA>`, the priorities source, and
  the option data source, and instantiate one copy per component you want audited. The
  template forbids reading the selection or scoring code, ranks the options blind, then
  reveals the system's actual choice and reports one JSON verdict: `AGREES`,
  `DEFENSIBLE_ALT`, `PRIORITY_UNDERWEIGHTED`, `CONSTRAINT_UNSTATED`, `OPTION_OVERLOOKED`, or
  `DATA_STALE`.

## Part of houserules

[houserules](https://github.com/DTCurrie/houserules) is a portable set of Claude Code
infrastructure that keeps the agent's context lean. This is one of twelve first-party plugins.
The [package list](https://github.com/DTCurrie/houserules#packages) has the rest.

## License

MIT. See [LICENSE](./LICENSE).
