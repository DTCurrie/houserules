# Phase 3: auto-sync

**Status:** TODO · **Part of:** [PLAN.md](PLAN.md) · **Roadmap:** [ROADMAP.md](ROADMAP.md)

## Objective

Nobody has to run `update` after a clone or a version bump. Done when two end-to-end cases pass on
a fixture: a fresh clone with dependencies installed and no ignored files ends its first hook run
with a complete install, and an install whose manifest names an older `kitVersion` than the
installed CLI ends its next hook run refreshed. In both, a locally edited ignored file is left
alone, and the hook exits 0 whatever happens.

## Reference

- [probe/RESULTS.md](probe/RESULTS.md): the trigger decision. Read it first. If it names `prepare`
  as primary, the SessionStart path in this phase becomes the backstop and gains a "restart the
  session" line.
- `packages/api/src/hook-wiring.ts`: `hookCommand()`. The `exec` in its head is load-bearing, per
  `packages/cli/CLAUDE.md`.
- `docs/payload.md` before writing the payload script.

## Steps

- [ ] `update` gains a `--sync` flag for unattended runs, beside `--force` in
      `packages/cli/src/cli.ts`. It creates, refreshes and prunes exactly as a plain `update` does,
      and differs in four ways: no prompts, no git index writes, exit 0 on every path including a
      failure, and output held to one line. That line is
      `[houserules] synced to <version>: <n> written, <m> kept (edited)`, or nothing when the
      install is current, or one `[houserules]` line naming the failure. It rejects `--force`. Acceptance: a test runs `--sync` against a current install
      and asserts empty stdout and an unchanged tree.
- [ ] A core SessionStart hook, wired in `packages/cli/src/modules/core.ts` with `hookFragment`
      as `session-context` wires its own, so no optional module gates it. The script is
      `packages/cli/payload/scripts/payload-sync.mts` (new), installed as
      `.claude/scripts/payload-sync.mjs` (new). It compares the manifest's `kitVersion` with the
      `version` in `node_modules/@houserules/cli/package.json`, and each `plugins[].version` in the
      manifest with the `version` in that plugin's `node_modules/<name>/package.json`. It checks that every manifest dest exists, and runs the local binary's
      `update --sync` on any mismatch. The comparison reads two small files, so a current install
      pays no CLI startup. Acceptance: a unit test covers current, older manifest, missing file and
      missing manifest, and the script exits 0 in each.
- [ ] `HookFallback` in `packages/api/src/hook-wiring.ts` gains a fourth value, `'bootstrap'`,
      passed only by the `payload-sync` hook. When the script is absent
      it runs the installed binary from `node_modules/.bin` with `update --sync`. When the binary is
      absent too, it prints the install hint and exits 0. It never calls `npx` without a local
      install. The other hooks keep their guard and hint fallbacks, with text that names the cause.
      Acceptance: a test executes the rendered command in a shell for all three states and asserts
      output and exit code.
- [ ] If phase 1 chose `prepare`: `init` and `update` write the root `package.json` `prepare`
      script themselves, by the user's decision on 2026-11-20 that a copy-and-paste step is not
      acceptable. With no `prepare` script, the value is `houserules update --sync`. With one, that
      command is appended after ` && `, and a script that already contains it is left alone. The
      edit goes through the plan/apply boundary as its own action, shows in the plan preview and
      `--dry-run` like the `settings.json` diff, changes only that one key, and keeps the file's
      indentation and trailing newline. A `package.json` that does not parse is reported and never
      rewritten. `update --sync` never makes this edit. `doctor` reports the script's absence and
      `doctor --fix` restores it. Acceptance: tests for no `prepare`, an existing `prepare`, an
      already-wired one, and an unparseable file, each asserting the file's bytes.
- [ ] Worktrees and cloud sessions follow whatever phase 1 observed. Write the handling as a step
      here once `RESULTS.md` exists, or record in Notes that the sync hook already covers them.
      Acceptance: the worktree case from phase 1 is rerun against this phase's build and its result
      is in Notes.
- [ ] README: a "Staying current" section covering the pin, the sync, and what a teammate sees
      after pulling a bump. Replace the missing-script passage. Record the changeset. Acceptance:
      the four gates exit 0.

## Review Focus

- Two sessions start at once in one checkout and both run the sync: the tree ends complete and the
  manifest parses, pinned by `packages/cli/src/commands/__tests__/update.test.ts`.
- The installed CLI is older than the manifest's `kitVersion`, as after a branch switch: sync
  writes the older payload and does not loop, pinned by `packages/cli/src/commands/__tests__/update.test.ts`.

## Notes & decisions
