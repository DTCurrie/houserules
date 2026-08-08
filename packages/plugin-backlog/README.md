# @agent-kit/plugin-backlog

[![npm](https://img.shields.io/npm/v/@agent-kit/plugin-backlog.svg)](https://www.npmjs.com/package/@agent-kit/plugin-backlog)
[![downloads](https://img.shields.io/npm/dm/@agent-kit/plugin-backlog.svg)](https://www.npmjs.com/package/@agent-kit/plugin-backlog)

An agent mid-task that finds real work outside its current scope has two bad options: fix it
inline and bloat the diff, or mention it in a chat message that scrolls away and is gone.
Neither leaves a record anyone can act on later.

This plugin gives the agent a third option: an append-only ledger it can log a deferred item
to in one command, plus a reviewer that gut-checks the entry before it lands.

If your install carries a `backlog` module id from before the CLI's built-in modules moved
into plugins, install this package to restore it under its plugin id.

## Install

```
pnpm add -D @agent-kit/plugin-backlog
pnpm exec agent-kit init
```

Requires [`@agent-kit/cli`](https://github.com/DTCurrie/agent-kit/tree/main/packages/cli).
`init` is what writes the module into `.claude/`. This module is off by default, so select it
when `init` asks.

## Modules

- **`backlog`** installs `.claude/scripts/backlog-log.mjs`, a ledger CLI with `add`, `remove`,
  `update`, `show`, and `list` subcommands. It also installs the `backlog-add` skill, which
  logs an out-of-scope discovery and stops rather than starting work on it, and the
  `backlog-reviewer` agent (haiku), which validates format, checks for duplicates, and
  gut-checks whether a fresh entry is worth tracking before the skill continues.

  A repo-wide entry renders to `.claude/ledgers/BACKLOG.md`. An entry scoped to a target
  named in `kit.config.json` renders to `.claude/ledgers/<target>.BACKLOG.md`. The rendered
  file is generated from the ledger, so a hand edit to it does not survive the next entry.

  The ledger directory is local to the repo and gitignored. `@agent-kit/plugin-github` is an
  optional companion that syncs it to a GitHub Project, which gives the ledger a durable home
  outside the repo.

## Part of agent-kit

[agent-kit](https://github.com/DTCurrie/agent-kit) is a portable kit of Claude Code
infrastructure that keeps the agent's context lean. This is one of twelve first-party plugins.
The [package list](https://github.com/DTCurrie/agent-kit#packages) has the rest.

## License

MIT. See [LICENSE](./LICENSE).
