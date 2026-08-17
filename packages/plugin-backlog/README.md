# @houserules/plugin-backlog

[![npm](https://img.shields.io/npm/v/@houserules/plugin-backlog.svg)](https://www.npmjs.com/package/@houserules/plugin-backlog)

An agent mid-task that finds real work outside its current scope has two bad options: fix it
inline and bloat the diff, or mention it in a chat message that scrolls away and is gone.
Neither leaves a record anyone can act on later.

This plugin gives the agent a third option: an append-only ledger it can log a deferred item
to in one command, plus a reviewer that gut-checks the entry before it lands.

If your install carries a `backlog` module id from before the CLI's built-in modules moved
into plugins, install this package to restore it under its plugin id.

## Install

```
pnpm add -D @houserules/plugin-backlog
pnpm exec houserules init
```

Requires [`@houserules/cli`](https://github.com/DTCurrie/houserules/tree/main/packages/cli).
`init` is what writes the module into `.claude/`. This module is off by default, so select it
when `init` asks.

## Modules

- **`backlog`** installs `.claude/scripts/backlog-log.mjs`, a ledger CLI with `add`, `remove`,
  `update`, `move`, `show`, `list`, and `render` subcommands. `move` re-points an entry to a
  different area, and `render` regenerates a `BACKLOG.md` file from the ledger without adding
  an entry. It also installs the `backlog-add` skill, which
  logs an out-of-scope discovery and stops rather than starting work on it, and the
  `backlog-reviewer` agent (haiku), which validates format, checks for duplicates, and
  gut-checks whether a fresh entry is worth tracking before the skill continues.

  A repo-wide entry renders to `.claude/ledgers/BACKLOG.md`. An entry scoped to a target
  named in `houserules.config.json` renders to `.claude/ledgers/<target>.BACKLOG.md`. The rendered
  file is generated from the ledger, so a hand edit to it does not survive the next entry.

  The ledger directory is local to the repo and gitignored. `@houserules/plugin-github` is an
  optional companion that syncs it to a GitHub Project, which gives the ledger a durable home
  outside the repo.

## Part of houserules

[houserules](https://github.com/DTCurrie/houserules) is a portable set of Claude Code
infrastructure that keeps the agent's context lean. This is one of twelve first-party plugins.
The [package list](https://github.com/DTCurrie/houserules#packages) has the rest.

## License

MIT. See [LICENSE](./LICENSE).
