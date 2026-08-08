# @agent-kit/plugin-github

[![npm](https://img.shields.io/npm/v/@agent-kit/plugin-github.svg)](https://www.npmjs.com/package/@agent-kit/plugin-github)
[![downloads](https://img.shields.io/npm/dm/@agent-kit/plugin-github.svg)](https://www.npmjs.com/package/@agent-kit/plugin-github)

GitHub integrations for agent-kit. Every module this plugin ships is selected as
`<alias>/<module>`, so the alias names the service and the module names the integration.

## `github/projects`

Syncs the agent-kit backlog and decision ledgers to GitHub Projects, so the durable record
lives on a board instead of in a committed `.jsonl`. The local ledger becomes a gitignored
push queue that holds only what has not reached the board yet. A push turns backlog entries
into real issues on a linked project, and decisions into draft items.

## Prerequisite

The `gh` CLI needs the `project` scope, which a normal `gh auth login` does not grant:

```
gh auth refresh -s project
```

This is the most common first-run failure.

## Who can sync

Pushing to the board needs **both** of these:

1. A local `.claude/ledgers/.projects.json`, written only by an explicit `bootstrap` run. It
   is gitignored, so it never arrives with a clone.
2. `maintain` or `admin` access on the repository.

Committed config moves one way only. `projects.autoSync: false` in `.claude/kit.config.json`
forbids sync repo-wide. `true` merely permits it and grants nothing by itself. **Granting
needs both conditions above. Denying needs either.**

A contributor without both gets a working local ledger that syncs nowhere. That is not a
broken state. The path in for them is the issues tab, and a maintainer adopts the issue from
there with the `backlog-adopt` skill.

## Setup

1. Install the package and the CLI:

   ```
   pnpm add -D @agent-kit/plugin-github @agent-kit/cli
   ```

2. Declare the plugin in `.claude/kit.config.json`:

   ```json
   {
     "plugins": [{ "name": "@agent-kit/plugin-github", "alias": "github" }]
   }
   ```

3. Run `agent-kit init` and enable the `github/projects` module when it asks. It is off by
   default.

4. As a maintainer with `maintain` or `admin` access, run bootstrap once:

   ```
   node .claude/scripts/projects-sync.mjs bootstrap
   ```

## What bootstrap creates

One project per ledger per target, plus the repo root, each linked to the repository.
Titles are `<repo> Backlog` and `<repo>/<target> Backlog` for the backlog ledger, and the
same pattern with `Decisions` for the decision ledger. The `<target>` segment is the
basename of that target's `pathPrefix` in `kit.config.json`, not the target's own `name`.

The title is the adoption key. A second `bootstrap` run matches an existing project by exact
title and adopts it rather than creating a duplicate. Renaming a board by hand breaks that
match and orphans it: the next `bootstrap` creates a new board instead of finding the old
one.

## The skills

- **`ledger-sync`** pushes the ledgers to the boards by hand, and reads what is pending and
  whether the sync gate currently allows a push.
- **`backlog-adopt`** adopts a reported GitHub issue into the backlog ledger and onto the
  project board, without rewriting the reporter's title or body.

## Auto-sync

A `SessionEnd` hook spawns `projects-sync.mjs push` detached and returns in milliseconds. It
fires on session end, on `/clear`, and on `/resume`, so it can run several times per CLI
process. It is silent on every opt-out path: no sync token, `autoSync: false`, or an empty
push queue all return with no output and no log line. A spawned push's own output lands in
`.claude/state/projects-sync.log`.

## What the local ledger holds

Only what a push still owes the board. The `.jsonl` files are append-only while work is in
flight, and every push ends by compacting them:

- An entry that reached the board and has not been touched since collapses to a single
  record carrying its issue number or draft item id.
- An entry removed before it ever reached the board is dropped outright, along with every
  record it wrote. Nothing on the board describes it, so nothing local needs to.
- An entry a push still owes something is left exactly as it was.

Without this the ledger grows with the work done rather than the work outstanding. In this
repo's own ledger that was 204 records describing two open entries, because 85 entries had
been filed and closed since the file was created.

Compaction is local and needs no network, so `compact` runs for contributors who cannot
push. It rewrites the ledger, so it keeps the previous copy beside it as
`<name>.jsonl.bak`, and it refuses to write at all if the compacted records would produce a
different push queue than the originals.

Run it by hand with `node .claude/scripts/projects-sync.mjs compact [--dry-run]`.

The rendered `BACKLOG.md` and `DECISIONS.md` are unaffected. A checkpoint record carries the
entry's folded state, so both surfaces render byte for byte the same before and after.

## Config

`projects.autoSync` in `.claude/kit.config.json` is a boolean. Its default is permissive:
when the key is absent, sync is allowed as long as the other two gate conditions hold.
Setting it to `false` forbids sync repo-wide regardless of who runs it.

## Known limits

- Saved project views are not reproducible through the GitHub API. `bootstrap` creates
  fields only, matching what `createProjectV2` can actually configure.
- There is no pull direction. Nothing reads a board back down into the ledger, so edits made
  directly on GitHub Projects do not reach `.claude/ledgers/`.

## Part of agent-kit

[agent-kit](https://github.com/DTCurrie/agent-kit) is a portable kit of Claude Code
infrastructure that keeps the agent's context lean. This is one of twelve first-party plugins.
The [package list](https://github.com/DTCurrie/agent-kit#packages) has the rest.

## License

MIT. See [LICENSE](./LICENSE).
