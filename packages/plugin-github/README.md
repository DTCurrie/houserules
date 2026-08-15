# @houserules/plugin-github

[![npm](https://img.shields.io/npm/v/@houserules/plugin-github.svg)](https://www.npmjs.com/package/@houserules/plugin-github)
[![downloads](https://img.shields.io/npm/dm/@houserules/plugin-github.svg)](https://www.npmjs.com/package/@houserules/plugin-github)

GitHub integrations for houserules. Every module this plugin ships is selected as
`<alias>/<module>`, so the alias names the service and the module names the integration.

## Install

```
pnpm add -D @houserules/plugin-github @houserules/cli
pnpm exec houserules init
```

Requires [`@houserules/cli`](https://github.com/DTCurrie/houserules/tree/main/packages/cli).
`init` is what writes the module into `.claude/`. This module is off by default, so select it
when `init` asks.

## Modules

- **`projects`**, selected as `github/projects` once the plugin is aliased `github`, syncs
  the houserules backlog and decision ledgers to GitHub Projects, so the durable record lives
  on a board instead of in a committed `.jsonl`. A push turns backlog entries into real
  issues on a linked project, and decisions into draft items. A pull rebuilds a local index
  from those boards, so every local query answers offline while the queue itself stays empty.
  See `` `github/projects` `` below for the full setup and behavior.

## `github/projects`

The full setup and behavior for the `projects` module, in depth.

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

Committed config moves one way only. `projects.autoSync: false` in `.claude/houserules.config.json`
forbids sync repo-wide. `true` merely permits it and grants nothing by itself. **Granting
needs both conditions above. Denying needs either.**

A contributor without both gets a working local ledger that syncs nowhere. That is not a
broken state. The path in for them is the issues tab, and a maintainer adopts the issue from
there with the `backlog-adopt` skill.

## Setup

1. Install the package and the CLI:

   ```
   pnpm add -D @houserules/plugin-github @houserules/cli
   ```

2. Declare the plugin in `.claude/houserules.config.json`:

   ```json
   {
     "plugins": [{ "name": "@houserules/plugin-github", "alias": "github" }]
   }
   ```

3. Run `houserules init` and enable the `github/projects` module when it asks. It is off by
   default.

4. As a maintainer with `maintain` or `admin` access, run bootstrap once:

   ```
   node .claude/scripts/projects-sync.mjs bootstrap
   ```

## What bootstrap creates

Two projects, `<repo> Backlog` and `<repo> Decisions`, both linked to the repository, no
matter how many targets the repo declares. See **Areas, not boards per package** below.

It also creates the fields each board needs, including the ones that exist so a board can
rebuild the local index: `Area`, `Filed`, and `Chat` on backlog, and `Area`, `Scope`, and
`Under` on decisions. Adoption never deletes a field you added yourself.

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

A `SessionEnd` hook spawns `projects-sync.mjs push` as a detached, unreferenced child process.
On the node side this is measured: the parent exits in about 0.02s against an 8-second child.
Whether Claude Code itself waits on that child before finishing session teardown has not been
confirmed. It fires on session end, on `/clear`, and on `/resume`, so it can run several times
per CLI process. It is silent on every opt-out path: no sync token, `autoSync: false`, or an empty
push queue all return with no output and no log line. A spawned push's own output lands in
`.claude/state/projects-sync.log`.

## Two local artifacts, and what each is for

The board is the durable record. Locally there are two files per ledger and neither is a
source of truth.

**The queue**, `.claude/ledgers/<kind>.jsonl`, holds only what has not reached the board.
A synced repo's queue is **zero bytes**. An entry is removed from it once two things both
hold: the push owes it nothing, and the index confirms the board actually has it. The
second is what makes the first safe, because a push that recorded success without its board
write landing would otherwise eat the only remaining copy.

**The index**, `.claude/ledgers/<kind>.index.json`, is a cache of what the boards hold. It
is what `scope`, `list`, `show`, and prompt injection read, so those answer offline and
instantly. Delete it and one `pull` rebuilds it.

The rendered `<area>.BACKLOG.md` and `<area>.DECISIONS.md` files are a readable view for
anyone who would rather not leave the codebase. `pull` re-renders them, so they track the
board rather than freezing at the last local write.

Nothing outside the board is load-bearing. Deleting the index and every rendered surface,
then running `pull`, restores all of them.

## Reading a closed entry

A finished backlog entry stays on the board as a closed issue and stays in the index. It is
filtered out of `list` and out of every rendered surface, and it still resolves through
`show` and through prompt injection, so a decision that cites a closed backlog id keeps
working.

## Areas, not boards per package

A repo gets exactly two boards, `<repo> Backlog` and `<repo> Decisions`, however many
targets it declares. Which package an entry belongs to is the `Area` field on the item.
A board per target multiplies: fourteen packages would mean twenty-eight boards, and moving
from a single package to a workspace would be a board migration rather than a config edit.

The repo name stays in the title because one account holds boards for many repos.

## Upgrading an existing install

Boards created before this version are missing the columns a pull needs, and their decision
drafts carry no entry marker, so nothing can map an item back to the entry it came from.
Two commands, in this order:

```
node .claude/scripts/projects-sync.mjs bootstrap   # adds the new fields
node .claude/scripts/projects-sync.mjs backfill    # fills them from the local ledger
```

`backfill` reads the LOCAL ledger and writes the board, which is the opposite direction from
everything else here, and it works only while the local ledger is still complete. Run it
before anything drains the queue. `--dry-run` prints the plan first, and a second run is a
no-op.

An item it cannot match to a local entry is reported and skipped rather than guessed at.

## Config

`projects.autoSync` in `.claude/houserules.config.json` is a boolean. Its default is permissive:
when the key is absent, sync is allowed as long as the other two gate conditions hold.
Setting it to `false` forbids sync repo-wide regardless of who runs it.

## Known limits

- `bootstrap` creates fields only. It does not configure the board's saved view, so a new
  board opens as a default table of every field. Setting the view up is reproducible through
  the API and simply is not done yet.
- `pull` is a projection, not a merge. It rebuilds the local index from the boards, and an
  edit made directly on GitHub Projects reaches the index on the next pull. It does not
  write back into the queue, so the board wins and there is no conflict to resolve.
- An item added to a board by hand carries no entry marker, so `pull` skips it. Adopt a
  reported issue with the `backlog-adopt` skill instead of adding it to the board directly.

## Part of houserules

[houserules](https://github.com/DTCurrie/houserules) is a portable set of Claude Code
infrastructure that keeps the agent's context lean. This is one of twelve first-party plugins.
The [package list](https://github.com/DTCurrie/houserules#packages) has the rest.

## License

MIT. See [LICENSE](./LICENSE).
