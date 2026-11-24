# Phase 8: closeout

**Status:** TODO · **Part of:** [PLAN.md](PLAN.md) · **Roadmap:** [ROADMAP.md](ROADMAP.md)
**Signals:** flat
**Domain:** `.claude/plans/ignored-payload/closeout` (new), `packages/cli/CLAUDE.md`

## Objective

The plan's work is ready for the user to commit. Done when the whole-tree gates' exit codes sit in
`closeout/gates.txt`, `closeout/acceptance-checklist.md`, `closeout/closes.md` and
`closeout/pr-description.md` exist, the two deferred items are in the backlog, and the ROADMAP
header reads `DONE`.

## Reference

- `packages/cli/payload/skills/plan-project/references/closeout.md`: the template this phase
  follows. The slice's agent is `closeout-worker`.

## Steps

- [ ] Run the whole-tree gates in order on the final tree: `pnpm format`, `pnpm lint:fix`,
      `pnpm build`, `pnpm check`, `pnpm test` and `pnpm dogfood`. Record each exit code in
      `closeout/gates.txt`. Acceptance: every code is 0, or the failure is fixed in its owning
      phase's files first.
- [ ] Dispatch the `closeout-worker` once, per the template, for the checklist, the Closes file and
      the PR description. This plan has no report. Acceptance: `closeout/pr-description.md` ends
      with the lines of `closeout/closes.md`.
- [ ] Record what the worker hands up through `/decide` and `/backlog-add`. Add two backlog rows
      whatever it returns: one hook dispatcher per event so `settings.json` stops changing with
      hook wiring, and a spike on distributing skills, agents and hooks as a native Claude Code
      plugin. Confirm every changed package has its changeset. Acceptance:
      `echo '{}' | node .claude/scripts/changeset-gate.mjs` exits 0.
- [ ] Update `packages/cli/CLAUDE.md` where a rule there now describes the old model: the
      generated-scripts rule, the kit-owned rule, and the formatter rule. Acceptance: a grep of that
      file for `scripts.commit` and "self-gitignored" finds only text that matches the shipped
      behavior.
- [ ] Flip the ROADMAP header to `DONE`, run `node .claude/scripts/plan-lint.mjs`, and hand the user
      the three closeout files. Acceptance: plan-lint prints no `ERROR` line.

## Notes & decisions
