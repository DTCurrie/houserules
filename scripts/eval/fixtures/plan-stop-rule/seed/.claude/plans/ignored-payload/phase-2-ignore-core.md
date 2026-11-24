# Phase 2: ignore-core

**Status:** TODO · **Part of:** [PLAN.md](PLAN.md) · **Roadmap:** [ROADMAP.md](ROADMAP.md)
**Signals:** wide

## Objective

A fresh `init` on a git fixture leaves `git status --porcelain` naming only the tracked set:
`.claude/houserules.config.json`, `.claude/settings.json`, `.claude/.gitignore` (new), the instructions
file, the seeds, and the existing per-directory `.gitignore` files. Deleting every ignored file and
the manifest, then running `update`, restores a byte-identical install. With
`payload.commit: true` the same `init` produces today's committed layout.

## Reference

- [PLAN.md](PLAN.md), "Approach": the locked decisions and the tracked set.
- `packages/cli/CLAUDE.md`, "Rules": the plan/apply boundary, kit-owned versus user-owned, managed
  regions and `SHARED_HOST_FILES`.
- `docs/testing.md` before writing any test, `docs/payload.md` if a payload file changes.

## Steps

- [ ] The config schema in `packages/api/src/config.ts` gains `modules`, an optional string array
      holding the same ids the manifest's `modules` holds today, and `payload`, a strict object
      with one optional boolean `commit`, shaped like `scripts.commit` beside it. `init` and the `modules` command write `modules` to the config.
      Every reader of `manifest.modules` reads the config first and falls back to the manifest, so
      an install from before this change still updates. Regenerate the JSON Schema. Acceptance: a
      test shows `update` computing the same plan from a config with `modules` and no manifest as
      from the manifest that install wrote.
- [ ] `update` with no manifest and a config that names `modules` installs from the config instead
      of stopping. With neither, it keeps today's message. No recorded hash means `classifyWrite`
      already treats an existing file as refreshable, so the rebuild writes the canonical bytes
      and the new manifest records their hashes. Acceptance: an end-to-end test deletes the
      manifest and every ignored file from an installed fixture, runs `update`, and compares the
      tree byte for byte with the original.
- [ ] The plan emits one managed block in `.claude/.gitignore` (new), a `region` action in a file the user
      may also own. It is built the way `packages/cli/src/modules/prettier-guard.ts` builds the
      `.prettierignore` block: a pass in `packages/cli/src/plan.ts` after every module's `plan()`,
      a region with id `gitignore` and the markers `# houserules:gitignore start` and
      `# houserules:gitignore end`, and the path added to `SHARED_HOST_FILES` so it is never
      created wholesale over user lines or pruned. The manifest hash covers the region body. The
      body lists the manifest and every `copy`, `write` and `body` dest under `.claude/`, one per
      line, sorted, relative to `.claude/` with a leading `/` so each line matches one file.
      Dests under a directory that already self-ignores with `*` are left out. Seeds and ledger
      records are never listed. With `payload.commit: true` the block is not written. Acceptance: a
      test with a user-authored skill beside the kit's skills shows `git check-ignore` matching each
      kit dest and not the user's file.
- [ ] The manifest is local state. Its hashes now describe this machine's files only, so
      `classifyWrite` treats a mismatch on an ignored dest as a local edit and returns
      `skip-modified`. The `isGenerated` escape stays as it is and stays scoped to scripts and
      templates, because a `payload.commit: true` install still carries a tracked manifest beside
      ignored scripts. Acceptance: a test edits an ignored rule, runs `update`,
      and finds the edit intact and reported.
- [ ] README: generalize the "`.claude/scripts/` is generated, not source" section to the whole
      payload, and correct "What `init` does" step 4. Record the changeset before handing off.
      Acceptance: `pnpm format`, `pnpm lint:fix`, `pnpm check` and `pnpm test` exit 0.

## Review Focus

- A repo whose own `.claude/.gitignore` (new) already has user lines: bytes outside the markers survive,
  pinned by `packages/cli/src/modules/__tests__/core.test.ts`.
- A plugin's dests enter the block the day the plugin is added, pinned by
  `packages/cli/src/__tests__/plan.test.ts`.
- `houserules.config.json` from before this change, with no `modules` key, still validates and
  updates, pinned by `packages/cli/src/commands/__tests__/update.test.ts`.

## Notes & decisions
