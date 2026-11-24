---
name: verify-changed
description: Verify changed packages and their dependents off-context by running check, test, and lint across a workspace or monorepo. Use directly only when the mechanical gates alone are wanted. `/ready` is the full pre-handoff pass.
allowed-tools: Bash(node .claude/scripts/verify-changed.mjs:*), Read
---

Verify the current change **without pulling the full test transcript into this context.**

The helper already compacts its output to one line per package plus a short residue tail per
failure, so a subagent buys nothing. Run it in the foreground by default. A foreground call holds the
turn open until it returns, and a completion notice that lands while no tool call is running does not
wake the session.

## What to do

1. Run `node .claude/scripts/verify-changed.mjs` from the repo root, without `--run`. It prints the
   plan preview. The first line says `<n> package(s) in scope`, and each package gets its own line.
2. If the preview lists 8 packages or fewer, run `node .claude/scripts/verify-changed.mjs --run` in
   the foreground with `timeout: 600000`. The output is the compact result, so read it directly.
3. If the preview lists more than 8 packages, start the same command with `run_in_background: true`
   instead. Then wait with foreground `sleep 20` calls, and check the output file after each one. Do
   not end the turn while the run is going. Claude Code refuses a long standalone foreground sleep, so
   do not write a longer one or a loop of sleeps in one call.
4. When the run has exited, `Read` the output file if you did not already have it. It is small, so
   read all of it.

The helper resolves the MINIMAL scope: the packages whose files changed against the base branch plus
every package that transitively depends on them. It prints `<pkg>: PASS` or `<pkg>: FAIL (<step>)`
per package, with a trimmed residue tail on stderr for any failure. Exit code is 2 if any package
failed, 0 otherwise. If it reports `FULL SCOPE (git/config unavailable)`, say so. The scope was
degraded to every package.

## Reconcile

Relay the per-package lines, and for each FAIL the failing step plus the shortest residue that
identifies the fix. If everything passed, say the change verifies clean and is ready for the user to
commit. If anything failed, fix it or hand the specific residue back, then re-run this skill. Never
wave a red verdict through.

If a FAIL timed out, either as a test timeout or as `timed out after <n>s`, and the run overlapped
other runs such as a wave's workers or another gate, treat it as a load timeout. Rerun the failing
package alone, once nothing else is running, under its share of the script budget, and read that
result as the verdict. Never raise a test timeout or `verify.timeoutMs` to make it pass, because the
timeout measured the load and not the test.

## Notes

- Scope math and command selection live in `verify-changed.mjs`, configured by the `verify` block and
  the per-target `verifyCommands` in `.claude/houserules.config.json`. Tune there, not here.
- `verify.timeoutMs` in `.claude/houserules.config.json` caps each command. A hung runner becomes
  `FAIL (<step>, timed out after <n>s)` instead of a stalled run.
- Preview the scope without running anything. `node .claude/scripts/verify-changed.mjs` prints the
  plan, and `--json` emits it machine-readably.
- `--paths a,b` replaces the git changed-path list with the paths you name. Each selected package is
  still verified package-wide, plus its dependents. `--full` selects every package and reads no git.
  The two flags cannot combine, and a usage error exits 1.
- `verify.relatedCommand` ships unset, because the kit cannot know a repo's test runner. With it
  unset, `--paths` verifies each package package-wide. For vitest, set it in the `verify` block to
  `exec vitest related --run {files}`, and `--paths` runs that template as the package's `test` step.
  A worker's iteration loop uses it too, unless `orchestrate.fileLevelAcceptance` is `false`. A
  file-level pass does not prove two things. It skips tests that reach the code through a child
  process, because `vitest related` follows the import graph. It also bypasses the build orchestrator, so the build
  does not run first, and a test that reads `dist/` runs against the last build.
- `verify.rootCommands` ships unset. In a monorepo, set it to workspace-root scripts such as
  `["verify"]` when the root holds repo-wide checks that read package paths, like an unused-export
  scan. The scope then ends with a root entry that runs those scripts at the repo root with no filter
  flag, after every package job. It applies whenever the scope holds a package or a changed path lies
  outside every package. A single-package repo never gets one.
- `--run` starts the jobs of packages with no dependency edge between them together, bounded by the
  resource budget, and runs a dependent after its dependency. Set `verify.concurrent: false` to
  restore the serial order.
- Who verifies, by stage:

  | Stage               | Runs                                                                         |
  | ------------------- | ---------------------------------------------------------------------------- |
  | Worker              | Its brief's acceptance, file-level when the slicing rule applies.            |
  | Wave                | Each slice's acceptance rerun, plus a typecheck of the packages it touched.  |
  | Phase or step       | `/verify-changed`. A milestone item leaves it to the step barrier.           |
  | Hand-off (`/ready`) | `/verify-changed`, with `--full` past 8 packages or on a root config change. |

  A worker does not run `/verify-changed`. It is package-granular, so parallel workers would test each
  other's half-edited files.

- This replaces a hand-maintained "shared packages" list. Dependents come from the workspace
  dependency graph, so a change to a leaf package still verifies its consumers.
