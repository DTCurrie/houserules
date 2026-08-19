# @houserules/plugin-changesets

[![npm](https://img.shields.io/npm/v/@houserules/plugin-changesets.svg)](https://www.npmjs.com/package/@houserules/plugin-changesets)

An agent that finishes a change and stops there leaves nothing behind for the next release.
Nobody remembers three weeks later which package a fix touched or what to write in the
changelog, and by then the diff is gone from context too.

This plugin wires changesets into the agent's own workflow: a script that authors a changeset
the same way `changeset add` would, a skill and an agent that do it after a completed change,
and a Stop hook that nudges when package source changed with no changeset alongside it.

## Install

```
pnpm add -D @houserules/plugin-changesets
pnpm exec houserules init
```

Requires [`@houserules/cli`](https://github.com/DTCurrie/houserules/tree/main/packages/cli).
`init` is what writes the modules into `.claude/`. The `changesets` module is on by default in
a monorepo, or when `.changeset/` already exists.

## Modules

- **`changesets`** installs `changeset-write.mjs`, a non-interactive changeset author for
  agents. It validates package names against the actual workspace, then writes through the
  repo's own `@changesets/write`, the same writer `changeset add` uses. That library is
  required: if it is not resolvable from the repo root, the script exits with the install
  command instead of hand-rolling a file. `--empty` records "no release needed", and `--absorb`
  folds one or more pending changesets into an amended one.

  It also installs `changeset-check.mjs`, a Stop hook that nudges when package source changed
  with no changeset recorded for it. **The hook exits 2 on purpose** when it fires: a non-zero
  exit is how a Stop hook tells Claude Code to keep going rather than end the turn, so the
  agent sees the nudge and can act on it in the same turn instead of losing the context. Every
  other path, including any internal failure, exits 0, so the hook can never break a session.
  It seeds `.changeset/config.json` when the repo has none, and writes the `/changeset` skill
  plus the `changeset-condense` skill and the `changeset-writer` agent (haiku).

  If `.changeset/config.json` is missing after install, or `@changesets/cli` is not a
  devDependency, `houserules doctor` reports it.

- **`ledger`** is optional and off by default. It installs `package-changelog.mjs`, which
  writes a per-commit JSONL changelog to `.claude/changelogs/`, plus a template for
  instantiating an archivist agent per target. It exists for repos that want commit-granular
  history alongside changesets, not instead of them. `.claude/changelogs/` never collides with
  the `CHANGELOG.md` that `changeset version` owns, because changesets is still the canonical
  changelog. See
  [`@houserules/cli`'s README](https://github.com/DTCurrie/houserules/tree/main/packages/cli#readme)
  for why.

## Upgrading from the CLI core

`changesets` and `ledger` were built-in CLI modules. A repo that recorded either before the
split gets a `HouseError` on its next `init` or `update` naming this package. Installing it and
adding it to the `plugins` array in `.claude/houserules.config.json` restores both modules and their
files. Nothing is deleted in the meantime.

## Part of houserules

[houserules](https://github.com/DTCurrie/houserules) is a portable set of Claude Code
infrastructure that keeps the agent's context lean. This is one of twelve first-party plugins.
The [package list](https://github.com/DTCurrie/houserules#packages) has the rest.

## License

MIT. See [LICENSE](./LICENSE).
