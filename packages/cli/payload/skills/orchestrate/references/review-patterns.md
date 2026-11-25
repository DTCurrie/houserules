# Judging a worker's evidence

Open this when a report looks green and you are deciding whether to believe it. `SKILL.md` §5 carries
the checks every review runs. This carries the failure shapes behind them, each one a case where an
accurate report carried no information.

## Why the tree check comes first

Destruction is what reports are worst at surfacing, because a worker that deleted something usually
did it in service of a step that then succeeded, so its acceptance is green and its summary is
accurate as far as it goes. A typechange means a real file became a symlink, which is almost never
intended.

## The evidence catalog

- **Acceptance evidence present and passing?** The one rule that keeps review from decaying into
  rubber-stamping. A test tail alone, where you also asked for a typecheck, is an unrun acceptance.
- **Did the acceptance actually RUN, or did the build system skip it?** An incremental runner
  (turbo, nx, bazel) reports a cache hit as success. `Ran 0 scripts and skipped 26` is a
  claim that a previous run with these inputs passed. A skip on unchanged declared inputs is a pass
  on the current bytes, and that is the reason the cache exists. A doubtful skip gets one check:
  do the changed files sit inside the script's declared inputs? If they do, the
  skip stands. If a changed file sits outside them, the skip proves nothing about that file, so
  verify it yourself directly. A skip is also worthless when the worker populated the cache itself
  moments earlier.
- **Do I re-run the worker's acceptance?** The acceptance output in the report is the evidence.
  Re-run an acceptance only when its output is missing, could be a cache skip outside the declared
  inputs, or you can name the doubt. The tree check (`git status`, `git diff --name-only` against
  the owned paths) still runs first. The barrier re-run in `references/nested.md` stays, because it
  follows the fixer and runs on changed files.
- **Could the evidence have come out any other way?** One worker mirrored a route across the wrong
  axis and confirmed it by reading the Z column back, but the fixture sat at z ≈ 0, where negating
  changes nothing, so correct and broken produce the same output. The report was accurate and carried
  no information. Where the acceptance is a value read rather than a command's exit code, ask what
  the reading would have been if the code were wrong. If the worker did not say, send it back.
- **Did it satisfy the letter and worsen the artifact?** One slice satisfied "the tarball must not
  carry these files" by excluding them in `files` while leaving a package `exports` entry pointing
  at them, which passes the check and publishes a package resolving to nothing.
  Another read "composites become recipes" as license to delete the controls inside them, and 208
  shipped UI files went in four waves. The misreading took a restructuring instruction for a
  removal instruction. The question that catches it: "What did the user lose that the plan did not
  name?" Anything a user could see or touch before and cannot now is a `Removed beyond plan` entry.
- **Is the deviation real, or an artifact of how you read the spec?** One orchestrator listed a
  sub-plan's steps with a first-line-only grep (`grep -nE '^\s+[0-9]+\.'`), which drops the
  continuation lines of wrapped list items, then sent a `REVISE` flagging a change that was
  step 5 of the spec. The worker pushed back with line numbers and the second pass approved,
  a full round spent on the reviewer's own extraction. Grep locates. Before a deviation verdict,
  `Read` the step you are judging against, in full.

## Revise rounds and what comes after the cap

Escalating the worker's model is the last resort, not the first.

Send a `REVISE` only after the worker's `finished` notice. A message sent before it appears to stay
inside the report already delivered, and a worker has no `SendMessage` to send its revised report
another way.

No `SendMessage` in your harness? Respawn with the original brief plus the defect list, and treat the
extra cost as another reason to keep the cap at 2.

## How much of the code to read

**Load-bearing** means the seam implementation, a security-relevant branch, the one hunk the brief
called out. Everything else stays unread.

## Before you accuse a worker of a deviation

Grep locates, and it shows only the first line of each list item. A `REVISE` grounded on that
extraction costs a full round when the worker can refute it with line numbers. `Read` the cited step in
full first. Do not read a full diff to settle it, because that forfeits the point of orchestrating.

## A worker that stalled

A stall (`Agent stalled: no progress for 600s`) reaches you as a report containing the word
"stalled", or as no report. Match on that word, not the full sentence. It is not a verdict, and the
slice is neither approved nor failed. The worker's partial edits are on disk, so run
`git diff --name-only` against the slice's `owns` and list what landed in the re-brief. A fresh
worker then builds on it instead of redoing it.

A worker that backgrounds a long command hands back an interim report at once, or none. The task
notification says it is waiting on its own background work and will deliver its report when that
finishes. Wait for that report. Reviewing the interim one judges work that has not finished.

## The diff reviewer

The diff reviewer catches defects the gates passed, and review recall falls with diff size. Skip it
silently when `.claude/agents/diff-reviewer.md` is absent.

### When it runs

At each wave barrier, after §7 step 3's recheck passes, count the changed lines not yet reviewed in
this phase. Count added plus deleted lines of tracked files with
`git diff --numstat HEAD -- <paths>`. Add the lines of untracked new files under those paths with
`git ls-files --others --exclude-standard -- <paths> | xargs cat | wc -l`, since `git diff` omits them.

- Over 150: dispatch the reviewer over those paths now.
- 150 or fewer: carry them to the next barrier.

At §8 phase close, review whatever is still unreviewed, once.

The 150 comes from the research: F1 falls from 0.657 under 10 changed lines to 0.043 over 150, per
https://arxiv.org/html/2606.15689.

### The brief

Make one `Agent` call with `subagent_type: diff-reviewer` and no model override. The brief is three
lines:

```
Diff: <the command that prints the change, such as `git diff HEAD -- <paths>`>
New files: <untracked paths the diff command cannot show, or none>
Spec: <the sub-plan's ## Objective and ## Steps, pasted verbatim>
```

### What a finding becomes

Work each finding in this order.

1. A finding whose `Command` is `none` is dropped. Count it.
2. Otherwise run the command yourself. If its output does not show the claimed failure, drop the
   finding and count it.
3. A shown defect in a file a slice of this phase owns becomes one `REVISE` to that slice's worker
   by `SendMessage`. It counts against the worker's two-round cap. Rerun that slice's acceptance.
4. A shown defect anywhere else becomes a backlog row, per §5's out-of-scope rule.
5. Never act on `## Cannot verify` entries. List them, with the dropped and acted-on counts, in the
   sub-plan's `## Notes & decisions`, so the reviewer's precision stays readable later.

Do not filter by confidence and do not add a second-opinion critic. The probe rated no finding high,
and dropping its low ones lost a real defect.
