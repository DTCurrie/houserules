# Phase 5: migrate

**Status:** TODO · **Part of:** [PLAN.md](PLAN.md) · **Roadmap:** [ROADMAP.md](ROADMAP.md)

## Objective

One `update` converts an install that committed its payload, and loses no edit. Done when an
end-to-end test on a fixture with a committed install, one edited skill and one rule with trimmed
`paths:` shows, after `update`: `modules` in the config, the edited skill in `ejected` and
still tracked, the trimmed `paths:` in the config, every other payload file and the manifest
removed from the index and present on disk, and nothing committed. A second `update` changes
nothing. With `payload.commit: true` the first `update` changes none of this.

## Reference

- `packages/cli/src/commands/update.ts`: `untrackAndReport`, `reportWouldUntrack`, and the scripts
  migration near line 455. This phase extends that path and keeps its staged-only rule.
- `packages/cli/src/commands/doctor/install-integrity.ts`: the stray-tracked checks.

## Steps

- [ ] `update` writes `modules` into a config that lacks it, from the manifest. Acceptance: covered
      by the end-to-end test in the Objective.
- [ ] The migration opens with a pre-verify pass that reads everything and writes nothing. It
      classifies every tracked payload file and collects the conditions that make an unattended
      migration unsafe: more than half the payload reading as edited, a tracked manifest that
      disagrees with the files on disk, payload paths with staged or unmerged changes, and a
      `.claude/` that git does not see as inside a repo. With none found, the migration proceeds
      and prints its summary. With any found, it shows each finding with its counts and asks how
      to proceed, one question per finding, each option saying what it will do to which files.
      Without a TTY it stops with exit 1, prints the same findings, and names the flag for each
      option. Each finding is its own function returning a finding or nothing, as the `doctor`
      checks are. Acceptance: a test per finding for the interactive answer, the flag, and the
      non-TTY stop, each asserting the index is unchanged until an option is chosen.
- [ ] After the pre-verify pass, `update` acts on its classification. A file whose status is
      `yours` or `conflict` is added to `ejected` and stays tracked. A rule whose only edit is its
      frontmatter moves its `paths:` into the config and is untracked. Acceptance: a test for each
      of the three cases, plus one for a rule with both a body edit and trimmed `paths:`.
- [ ] The remaining tracked payload files and the manifest are removed from the index with the
      working tree untouched. The summary lists the counts, names each auto-ejected file, and says
      the change is staged for the user to commit. `--dry-run` prints the same summary and writes
      nothing. `update --sync` never runs this migration, since it writes the git index.
      Acceptance: a test asserts `git diff --cached --name-status` after the run and an unchanged
      index after `--dry-run`.
- [ ] `doctor` reports a tracked payload file that is neither ejected nor covered by
      `payload.commit: true`, with the `update` line that fixes it, and reports an install where
      half the team has migrated: a tracked manifest beside an ignore block. Acceptance: tests for
      both findings.
- [ ] A formatter that rewrote the committed payload makes every file read as edited, which would
      eject the whole install. The count is files: tracked, not yet ejected, hash-tracked payload
      files. More than half of them classifying as `yours` or `conflict` is the pre-verify
      finding. Its options are three: take houserules' copies, which is `--force` with its
      existing meaning. Eject every edited file, which is `--eject-all` (new, valid only during
      this migration). Or stop and change nothing, so the user can run `doctor` and look at the
      diffs first. Acceptance: a test with every file reformatted asserts all three outcomes.
- [ ] Run the migration on `schoolyard-games`, the acceptance repo outside this workspace, on a
      branch, only after asking the user. The main conversation does this, never a worker.
      Record what it staged in Notes. Acceptance: Notes hold the staged file count and the
      auto-ejected list, or the user's decision to skip.
- [ ] README: an upgrade note for existing installs, and the `payload.commit` opt-out. Record the
      changeset as a minor bump with the migration named. Acceptance: the four gates exit 0.

## Review Focus

- A repo that is not a git repo, or whose `.claude/` sits in a subdirectory of the git root:
  migration skips or resolves paths correctly, pinned by
  `packages/cli/src/commands/__tests__/update.test.ts`.
- An install with `scripts.commit: true` and no `payload.commit`: scripts stay committed and the
  rest migrates, pinned by `packages/cli/src/commands/__tests__/update.test.ts`.

## Notes & decisions
