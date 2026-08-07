# @agent-kit/plugin-decisions

[![npm](https://img.shields.io/npm/v/@agent-kit/plugin-decisions.svg)](https://www.npmjs.com/package/@agent-kit/plugin-decisions)
[![downloads](https://img.shields.io/npm/dm/@agent-kit/plugin-decisions.svg)](https://www.npmjs.com/package/@agent-kit/plugin-decisions)

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
pnpm add -D @agent-kit/plugin-decisions
pnpm exec agent-kit init
```

Requires [`@agent-kit/cli`](https://github.com/DTCurrie/agent-kit/tree/main/packages/cli).
`init` is what writes the module into `.claude/`. This module is off by default, so select it
when `init` asks.

## Modules

- **`decisions`** installs `.claude/scripts/decision-log.mjs`, a ledger CLI with `decide`,
  `supersede`, `amend`, `rescope`, `show`, `list`, `scope`, `ancestry`, `current`, and `tree`
  subcommands. A scope holds literal paths, so `rescope` re-points a record after a file move
  and `scope` warns about the records whose paths have gone stale. It also installs the
  `decide` skill, which enforces a recording bar (the
  decision must constrain code non-obviously, a competent person could plausibly have chosen
  otherwise, and re-deriving it must cost real time) and requires a rejected alternative and a
  revisit trigger on every record, and the `decision-reviewer` agent (haiku), which checks a
  fresh record against that bar.

  A repo-wide decision renders to `.claude/ledgers/DECISIONS.md`. A decision scoped to a
  target named in `kit.config.json` renders to `.claude/ledgers/<target>.DECISIONS.md`. The
  rendered file is not auto-loaded into context. An agent reaches a decision through the
  skill, the reviewer, or an id cited in a prompt.

## Part of agent-kit

[agent-kit](https://github.com/DTCurrie/agent-kit) is a portable kit of Claude Code
infrastructure that keeps the agent's context lean. This is one of eleven first-party plugins.
The [package list](https://github.com/DTCurrie/agent-kit#packages) has the rest.

## License

MIT. See [LICENSE](./LICENSE).
