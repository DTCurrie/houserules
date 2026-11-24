### houserules sections

Maintained by `npx houserules update`, which rewrites this whole file. `CLAUDE.md` imports it between the houserules markers, and text outside those markers is yours and never touched.
Fuller templates live in `.claude/templates/`.

### Conventions

- **The user always handles `git commit` / `push` / PR-create.** Describe what is ready and stop.
- **Edit from the file's current bytes.** Re-read before editing when your view of it is
  second-hand (a snapshot, a lint error, another tool's output) or the user may have it open.
- **Do not rewrite what is not yours to change.** When the user presents a file as their own
  finished work, or has it open mid-edit, surface the problem and let them decide.
- **Watch for the missing `[houserules]` SessionStart banner.** Without it, the session started
  below the repo root and the installed hooks, including the Bash guard, are not active. Tell
  the user to relaunch Claude Code from the repo root.

### Cost & verification discipline

- Implement stage-sized work (a handful of files) in-context, with no implementation subagents.
  Reserve subagents for parallel or unbounded work (wide sweeps, migrations).
- Verify with static gates (tests, typecheck, lint) plus a short falsifiable acceptance checklist
  for the user. No browser/screenshot verification unless explicitly asked.
- Run them in order, scoped to the packages you changed: format first, then lint with autofix,
  then typecheck and test, so only real problems are left.
- **"Done" means every check passed, not that the edits were made.** Report a check that failed
  or never ran, with its output. The recorded evasions, and what each one means:
  - "The edits are in, so it is done": done is the checks passing, with output you read.
  - "I know this fact from memory": a fact from training data or an earlier session is a guess
    until a command confirms it. A fact this session already observed, on files unchanged since,
    is evidence. Cite where you saw it instead of re-running, since a re-run costs wall time and
    finds nothing new.
  - "It passed earlier": a pass is stale only when a file it covers changed after it ran. A
    content-hash skip on unchanged inputs is a pass. It proves nothing about a file outside the
    script's declared inputs.
  - "The subagent reported success": check the tree, meaning `git status` and
    `git diff --name-only` against the slice's owned paths. The acceptance output in the report
    is the evidence. Re-run an acceptance only when its output is missing, could be a cache skip
    outside the declared inputs, or you can name the doubt.
  - "The draft might be wrong": an artifact that already passed a review round is edited where
    it changes, not re-verified claim by claim.
  - "Let me confirm first": when the user asked for an action that is cheap to reverse and its
    content is ready, take it, then check the result once. Before it, at most one check, and only
    for a claim you can name a doubt about. Cheap to reverse: editing a pull request or issue
    body, a local edit under version control, a re-runnable command with no effect outside the
    repo. Not cheap: a push, a publish, a merge, a delete, or a message to another person.
- Derive empirical constants by parsing the artifact itself, not screenshot-and-iterate loops.
- A subagent runs a command expected to outlast the default Bash timeout with
  `run_in_background: true`, ends its turn without reporting, and reports when the completion
  notification re-invokes it, reading the output file it names. A foreground call blocks the
  subagent until Claude Code moves it to the background anyway, so starting it there saves the
  blocked minutes and lets the subagent end its turn. A command expected to finish inside the
  default Bash timeout, such as a scoped test or typecheck, runs in the foreground.
- Before writing a file or document the user asked for, read only what the ask names, write a
  first version, then check it once.
- On AskUserQuestion timeout, stop and re-ask later. Never carry tentative selections forward.
- Read the repo's own docs + targeted greps before fanning out Explore/Plan agents.

### Tool-use efficiency

- `grep -n` to locate, then `Read` with `offset`/`limit`. Grep output is location data, not
  content: never judge text against a grep listing of it.
- Pipe long command output through `grep`, and batch related greps into one call.
- The Bash tool's `grep` skips gitignored files when a recursive search starts at or above an
  ignored directory such as .claude/plans. Root the search inside that directory, name the
  files, or call `command grep`.
