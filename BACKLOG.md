# Backlog — repo root

Deferred work. Add entries via `.claude/scripts/backlog-log.mjs`; remove on resolution.

## [KIT-a49714] Revisit TypeScript 7 once typescript-eslint supports it

**Logged:** 2026-07-31
**Chat:** 3c00b063-c422-4b20-8928-e969f10ea399

Pinned typescript to ^6.0.3 in phase 1 of kit-v2: typescript-eslint@8.65 peers 'typescript >=4.8.4 <6.1.0' and hard-errors on TS 7.0 (the Go port), with no side-by-side story for eslint. Tracking issue: typescript-eslint#10940. Bump to TS 7 when that lands.

---

## [CLAUDEKIT-f216db] Scope task-worker acceptance to owned paths, not the whole repo

**Logged:** 2026-08-02
**Chat:** 37858c79-9026-4397-b70c-f9607150e3dc

Observed in practice: `task-worker` subagents run repo-wide verification for their acceptance (full
`pnpm test`, full typecheck, whole-suite lint). That is wrong by construction for the way
`/orchestrate` dispatches them. Workers run in parallel on disjoint `owns` sets, so at the moment any
one of them runs acceptance, its siblings are mid-edit. A red suite then says nothing about the
slice, and the worker either reports a spurious `BLOCKED` or reaches outside its owned paths to "fix"
a sibling's half-written file, which is the exact clobber the ownership rule exists to prevent.

Acceptance for a slice should be targeted at the files that slice owns. A named test file, a
typecheck of the owned module, a grep that proves the change landed. Repo-wide verification is
already the orchestrator's job at the wave barrier, where the tree is quiet (SKILL.md section 7 runs
`/verify-changed` once, after every slice has reported).

Two places need the edit, and they need it consistently:

- `payload/skills/orchestrate/SKILL.md` section 1 defines a slice's "falsifiable done" as "a command
  whose output proves it (a named test, a build, a grep)", and section 4's brief template hands the
  worker `Acceptance: run <command> and include its last ~10 lines`. Neither says that command must
  be scoped to `owns`, and "a build" invites exactly the whole-repo run. The slicing guidance should
  require a targeted command and say plainly that a whole-suite run is not a valid slice acceptance.
- `payload/agents/task-worker.md` says "Run the acceptance yourself" and "if it fails and you can't
  fix it inside your owned paths, report the failure honestly under `Blocked`". It needs the
  companion rule: a failure originating outside your owned paths is not your slice. Do not fix it,
  do not report `BLOCKED` on it, note it under `Out of scope` and move on. The agent already makes
  this argument for lint and format ("a fixer run from here rewrites files your siblings still have
  open"), so this is the same reasoning applied to verification.

Worth checking whether the same assumption leaks into the `sweep` skill's per-shard verification.

---

## [CLAUDEKIT-9247bb] prose-voice loads on any markdown read, not on prose-authoring intent

**Logged:** 2026-08-02
**Chat:** ac2674a8-5868-45d6-a3ec-eb83c0210f5c

`.claude/rules/*.md` with a `paths:` list loads when a matching file enters the working set, and
entering the working set includes a plain **Read**. It is not gated on write intent. So
`payload/rules/prose-voice.md`, whose globs are `**/*.md` plus `.changeset/`, `.claude/**` and
`.github/**`, loads whenever the agent reads any markdown at all. Observed live: a turn that only
answered a question, after reading `BACKLOG.md` and a `SKILL.md`, pulled in the full rule. 77 lines
and about 3KB spent on a turn that authored no prose.

Markdown is the worst case for this trigger. Reading a `.ts` file usually does precede editing it, so
`code-comments` and `code-cleanliness` mostly pay off. Reading a `.md` file usually does not. Docs,
plans, backlogs, skills and READMEs are what an agent reads to answer a question, so the rule fires
hardest exactly when it is least needed.

The docs also currently overstate the trigger. `README.md` line 70 says prose-voice is "path-scoped
to markdown, so it loads when the agent is writing a changeset, plan, or doc". It loads when the
agent _touches_ one, in either direction. `CONVENTIONS.md` section 6 is more careful ("when a
matching file is in the working set") but presents prose-voice as a worked example of scoping done
right, without noting the read-side cost. Whatever the fix, both need to describe the trigger
accurately.

Options, roughly in increasing cost:

- **Narrow the globs.** Drop the blanket `**/*.md` and keep only the dirs the agent authors into
  (`.changeset/*.md`, `.claude/plans/**/*.md`). Cheap and stays hookless. Does not actually fix the
  read-versus-write problem, it only shrinks the surface that trips it, and it gives up README and
  docs edits, which are a real use of the rule.
- **Gate on write intent with a hook.** A `PreToolUse(Edit|Write)` matcher on markdown paths that
  injects the rule only when a write is about to happen. This is precisely "load on authoring
  intent". `read-guard` already establishes the PreToolUse pattern in this codebase. First: verify
  whether `PreToolUse` stdout or `hookSpecificOutput.additionalContext` actually reaches the model's
  context on the CLI version we target. If it does not, this option is dead and the entry should say
  so. Note the tradeoff: `prose-voice` ships today with no hook and no CLAUDE.md pointer, and
  CONVENTIONS.md section 6 holds that up as the clean pattern. Adding a hook trades that purity for
  a tighter trigger.
- **Check whether the rule frontmatter grew a tool filter.** The `paths:` behavior in CONVENTIONS.md
  is marked "verified against Claude Code 2.1.220". Re-verify against current before building
  anything, in case a native gate now exists.

Applies to the other three rules in degree, not in kind. Worth re-measuring all four against
`doctor`'s resident-surface budget once the trigger question is settled.

---

## [CLAUDEKIT-8e6742] doctor crashes on a kit.config.json whose targets is not an array

**Logged:** 2026-08-02
**Chat:** 71b57f0c-75a8-4ce5-ad2f-ead436a9bf23

`detect()` reads kit.config.json with `readJson<KitConfig>()`, an unchecked cast, so a
structurally wrong config reaches the checks unvalidated. `checkConfigValidity` then does
`(config.targets ?? []).map(...)`, which throws `TypeError: .map is not a function` when
`targets` is a string. doctor dies with an uncaught stack trace instead of exiting 2 with the
schema errors it had already collected, which is exactly the case exit code 2 exists for.

Reproduce: set `"targets": "nope"` in `.claude/kit.config.json`, run `npx claude-kit doctor`.

Pre-existing, not introduced by the doctor decomposition. Surfaced by a unit test written
against `checkConfigValidity` while splitting `src/commands/doctor/`; the test was retargeted
at a non-crashing schema violation so it would not encode the crash.

The fix is a decision, not a one-liner: either return right after `configProblems` is non-empty
(a rejected config means the reality checks are reading garbage anyway), or make each target
loop defensive. The first is smaller and matches the "config outranks everything" rule already
in `doctorExitCode`, but it changes output for anyone whose config both fails the schema and
has real target problems, so it needs its own changeset.

---

