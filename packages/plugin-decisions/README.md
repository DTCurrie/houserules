# @houserules/plugin-decisions

[![npm](https://img.shields.io/npm/v/@houserules/plugin-decisions.svg)](https://www.npmjs.com/package/@houserules/plugin-decisions)

A design decision settled in conversation is gone the moment the context that produced it
scrolls away. The next agent, or the same one a week later, re-argues a question that was
already closed, because nothing on disk says why the codebase looks the way it does or what
was rejected to get there.

This plugin ships an append-only decision ledger: a skill that records a decision only when
it clears a stated bar, and a reviewer that checks the record against that bar before it
lands. Records are never edited, only superseded or amended, so the history stays intact.

If your install carries a `decisions` module id from before the CLI's built-in modules moved
into plugins, install this package to restore it under its plugin id.

## Install

```
pnpm add -D @houserules/plugin-decisions
pnpm exec houserules init
```

Requires [`@houserules/cli`](https://github.com/DTCurrie/houserules/tree/main/packages/cli).
`init` is what writes the module into `.claude/`. This module is off by default, so select it
when `init` asks.

## Modules

- **`decisions`** installs `.claude/scripts/decision-log.mjs`, a ledger CLI with `decide`,
  `supersede`, `amend`, `move`, `rescope`, `show`, `list`, `render`, `scope`, `ancestry`,
  `current`, and `tree` subcommands. `move` re-points a record to a different target's ledger,
  and `render` regenerates a `DECISIONS.md` file from the ledger without adding a record. A
  scope holds literal paths, so `rescope` updates the paths a record covers after a file move
  and `scope` warns about the records whose paths have gone stale. It also installs the
  `decide` skill, which enforces a recording bar (the
  decision must constrain code non-obviously, a competent person could plausibly have chosen
  otherwise, and re-deriving it must cost real time) and requires a rejected alternative and a
  revisit trigger on every record, and the `decision-reviewer` agent (haiku), which checks a
  fresh record against that bar.

  A repo-wide decision renders to `.claude/ledgers/DECISIONS.md`. A decision scoped to a
  target named in `houserules.config.json` renders to `.claude/ledgers/<target>.DECISIONS.md`. The
  rendered file is generated from the ledger, so a hand edit to it does not survive the next
  record. It is not auto-loaded into context. An agent reaches a decision through the skill,
  the reviewer, or an id cited in a prompt.

  The ledger directory is local to the repo and gitignored. `@houserules/plugin-github` is an
  optional companion that syncs it to a GitHub Project, which gives the ledger a durable home
  outside the repo.

## Part of houserules

[houserules](https://github.com/DTCurrie/houserules) is a portable set of Claude Code
infrastructure that keeps the agent's context lean. This is one of twelve first-party plugins.
The [package list](https://github.com/DTCurrie/houserules#packages) has the rest.

## License

MIT. See [LICENSE](./LICENSE).
