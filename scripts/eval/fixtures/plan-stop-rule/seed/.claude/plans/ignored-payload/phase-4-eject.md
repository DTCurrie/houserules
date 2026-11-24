# Phase 4: eject

**Status:** TODO · **Part of:** [PLAN.md](PLAN.md) · **Roadmap:** [ROADMAP.md](ROADMAP.md)

## Objective

A team can customize an installed file and share the result. Done when `houserules eject <path>`
on a fixture makes that file show in `git status` as untracked rather than ignored, a later
`update` leaves it alone and reports it `yours`, a kit-side change to it reports `conflict`, and
`houserules eject --undo <path>` returns it to the ignored, refreshable set. A rule's `paths:`
set in the config survive an `update` with the rule file itself still ignored.

## Reference

- `packages/cli/src/core/drift.ts`: `yours`, `conflict`, `isLocalEdit`. Eject reuses these and adds
  no status.
- `packages/cli/README.md`, "Rules: you own the frontmatter, houserules owns the body", and the
  `body` action in `packages/api/src/actions.ts`.

## Steps

- [ ] The config gains `ejected`, a list of repo-relative dests. The ignore block from phase 2
      leaves those dests out. Acceptance: a test shows `git check-ignore` no longer matching an
      ejected dest after `update`.
- [ ] `houserules eject <path...>` validates each path against the manifest, adds it to `ejected`,
      and rewrites the ignore block. It refuses a path houserules does not own and a path under
      `.claude/scripts/`, each with a message that says why. `--undo` removes the entry and leaves
      the file's bytes alone. An edited file then reads as a local edit to an ignored file, which
      the fourth step reports. Acceptance: tests cover an owned path, an unknown path, a script, and
      undo.
- [ ] An ejected file is planned exactly as a committed file is today, so the existing `yours` and
      `conflict` reporting and `--force` apply unchanged. One case is new. On a fresh clone there
      is no manifest, and a file with no recorded hash is refreshable, which would overwrite a
      teammate's ejected edit. So an ejected dest that exists is never written without `--force`,
      and with no manifest its recorded hash is the canonical one, which makes it read `yours`.
      Acceptance: a second test deletes the manifest, runs `update`, and finds the ejected edit
      intact. The first: a test ejects a file, edits
      it, bumps the canonical content, and asserts `conflict` with a diff.
- [ ] A local edit to an ignored, un-ejected file is reported by `update` and `doctor` with the
      exact `houserules eject <path>` line to keep it, and the existing `doctor --fix --force` line
      to discard it. `update --sync` keeps its one line from phase 3 and appends
      `run houserules doctor` when the kept count is above zero. Acceptance: a test asserts both lines appear for
      such a file.
- [ ] The config gains `rules`, a record keyed by rule id whose value is a strict object with one
      optional string array `paths`. A rule id is the file's name under `.claude/rules/` without
      `.md`, which is unique because every plugin's rules install into that one directory. The
      planner renders a rule's frontmatter
      from the config value when one is set and from the shipped default otherwise, so the `body`
      split no longer depends on a hand-edited file. The "shipped default moved" notice keeps
      working against the config value. Regenerate the JSON Schema. Acceptance: a test sets `paths`
      for one rule, runs `update` twice, and finds the rendered frontmatter stable and the body
      refreshed.
- [ ] README: add an "Editing an installed file" section and rewrite the rules frontmatter section.
      Record the changeset. Acceptance: the four gates exit 0.

## Review Focus

- A path given with a leading `./` or as an absolute path resolves to the same manifest dest,
  pinned by `packages/cli/src/commands/__tests__/eject.test.ts` (new).
- An ejected file whose module is later disabled is kept and reported, never pruned, pinned by
  `packages/cli/src/commands/__tests__/update.test.ts`.

## Notes & decisions
