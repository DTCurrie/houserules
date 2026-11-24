# Phase 1: probes

**Status:** TODO · **Part of:** [PLAN.md](PLAN.md) · **Roadmap:** [ROADMAP.md](ROADMAP.md)
**Signals:** flat
**Domain:** `.claude/plans/ignored-payload/probe` (new)

## Objective

Four facts about Claude Code are on record, each from a run that could have come out the other way.
Done when `.claude/plans/ignored-payload/probe/RESULTS.md` (new) holds one section per probe with
the `claude --version`, the exact commands, the observed output copied byte for byte, and a
one-line verdict. Its last section names the primary sync trigger for phase 3 and says whether
phase 7 runs.

## Reference

- Headless probe facts from earlier passes in this repo, restated: under `claude -p` a
  `permissions.allow` entry in project settings was ignored, so pass permissions on the command
  line. A hook that reads stdin needs stdin supplied.
- This repo already ignores `.claude/*` and its skills, rules and agents load. That shows ignored
  files load when they exist before the session starts. It says nothing about files that appear
  during SessionStart.

## Steps

- [ ] **Load order.** In a throwaway repo under the scratchpad, wire a SessionStart hook that writes
      one skill, one rule with no `paths:`, one agent and one output style, each carrying a unique
      token. Start a headless session and ask it to list its skills and agents and to quote the
      rule's token. Run it twice: files absent before start, and files present before start as the
      control. Acceptance: `RESULTS.md` says, per file kind, whether a file written during
      SessionStart is visible in that same session.
- [ ] **Worktrees.** In a repo with an ignored `.claude/skills/` file and ignored scripts, create a
      git worktree and list what `.claude/` holds there. Then start a session in the worktree and
      record which hooks fire and what each prints. Acceptance: `RESULTS.md` lists the files present
      and absent in the worktree and the hook output, and says whether `$CLAUDE_PROJECT_DIR` points
      at the worktree or the main checkout.
- [ ] **No `node_modules`.** In a fresh clone of that repo with dependencies not installed, start a
      session and record every hook's output and exit code. Acceptance: `RESULTS.md` shows the
      current guard and hint text as printed, and whether the session was usable.
- [ ] **`@import` of an ignored file.** Give CLAUDE.md one `@.claude/<file>` line pointing at an
      ignored file with a unique token, and ask a headless session to quote it. Repeat with the file
      absent. Acceptance: `RESULTS.md` says whether the import loads, and what the session sees when
      the target is missing.
- [ ] **Decide.** From the first three results, write the trigger decision: SessionStart sync alone,
      or a root `prepare` script as the primary trigger with SessionStart as the backstop that tells
      the user to restart. From the fourth, write whether phase 7 runs. Acceptance: both decisions
      are in `RESULTS.md`, each citing the probe section it rests on, and the ROADMAP marks phase 7
      `BLOCKED` with the reason if the import does not load.
- [ ] **Rewrite phase 3's two conditional steps.** Whoever closes this phase edits
      [phase-3-auto-sync.md](phase-3-auto-sync.md) so its `prepare` step and its worktree step say
      what to build, or are deleted. Acceptance: phase 3 has no step that begins "If phase 1" or
      tells the reader to write a step later.

## Notes & decisions
