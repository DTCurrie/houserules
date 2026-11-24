# Phase 7: import-region

**Status:** TODO · **Part of:** [PLAN.md](PLAN.md) · **Roadmap:** [ROADMAP.md](ROADMAP.md)

## Objective

A houserules release stops changing the user's CLAUDE.md. Done when a fresh `init` writes a managed
region holding one `@import` line that points at an ignored file under `.claude/`, that file holds
what the region held before, and an `update` across a change to the rendered sections leaves
`git status` clean. Runs only if phase 1's fourth probe found that an import of an ignored file
loads. Otherwise this phase is `BLOCKED` and stays so.

## Reference

- [probe/RESULTS.md](probe/RESULTS.md), the `@import` section, including what a session sees when
  the target is missing.
- `packages/cli/src/core/claude-md-region.ts` and `packages/cli/src/render.ts`.
- `packages/cli/CLAUDE.md`, "Managed regions": only bytes between the markers are written.

## Steps

- [ ] The rendered sections move to an ignored, manifest-tracked file under `.claude/`, and the
      region body becomes the one import line. The region's manifest hash covers that line.
      Acceptance: a test renders two different section sets and asserts the instructions file's
      bytes are identical across them.
- [ ] `update` converts an existing region in place. A region the user edited is `yours` today and
      stays untouched, with the diff shown. Acceptance: tests for a pristine region and an edited
      one.
- [ ] The missing-target case follows what phase 1 observed. If a session with the target absent
      loads no houserules instructions and says nothing, the sync hook from phase 3 prints the
      restart line when it had to create that file. Acceptance: Notes record the observed behavior
      and the handling chosen, with the test that pins it.
- [ ] `claudeMd.managed: false` and an `AGENTS.md` instructions file keep working. If the import
      syntax does not apply to `AGENTS.md`, that file keeps the full region. Acceptance: a test per
      case.
- [ ] README: update the marked-block passage. Record the changeset. Acceptance: the four gates
      exit 0.

## Notes & decisions
