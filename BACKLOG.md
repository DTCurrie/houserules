# Backlog — repo root

Deferred work. Add entries via `.claude/scripts/backlog-log.mjs`; remove on resolution.

## [KIT-a49714] Revisit TypeScript 7 once typescript-eslint supports it

**Logged:** 2026-07-31
**Chat:** 3c00b063-c422-4b20-8928-e969f10ea399

Pinned typescript to ^6.0.3 in phase 1 of kit-v2: typescript-eslint@8.65 peers 'typescript >=4.8.4 <6.1.0' and hard-errors on TS 7.0 (the Go port), with no side-by-side story for eslint. Tracking issue: typescript-eslint#10940. Bump to TS 7 when that lands.

---

## [CLAUDEKIT-05896a] Split src/types.ts and src/commands/doctor.ts into modules

**Logged:** 2026-08-02
**Chat:** f64be1d6-c130-4301-b887-11f04e395435

Both files show the pattern the code-comments rule flags: they needed landmark dividers to navigate. The dividers were deleted in the comment sweep, but the underlying shape was left alone.

types.ts is 432 lines across 10 sections (detection, answers, actions, effects, settings, manifest, config, modules, plan engine, CLI). doctor.ts is 792 lines mixing resident-surface measurement, config validation, hook checks, changesets, drift, and reporting.

Splitting types.ts into src/types/*.ts behind a barrel would keep the `src/types.js` import path every module already uses, so the churn is contained. CLAUDE.md names src/types.ts as the shared seam and would need a matching edit. doctor.ts splits along its finding groups, each returning Finding[].

Deferred from the code-comments sweep: it is an import-churn refactor, not a comment change.

---

## [CLAUDEKIT-bc0a96] Remove catch-all files flagged by the new code-cleanliness rule

**Logged:** 2026-08-02
**Chat:** 37858c79-9026-4397-b70c-f9607150e3dc

The code-cleanliness rule now bans `types.ts`, `constants.ts`, `utils.ts`, `shared.ts`, and `helpers.ts` by name. This repo has two of them, so the kit violates a rule it ships.

Violations, both under src/:

- `src/types.ts` (405 lines) — already tracked for splitting by CLAUDEKIT-05896a, which reached the same conclusion from the code-comments angle (it needed landmark dividers to navigate). That entry owns the split. Listed here only so the rule-violation view is complete.
- `src/modules/shared.ts` (151 lines) — NOT covered by any existing entry. Holds the action factories every module imports: script, lib, skill, agent, rule, reference, template, hookCommand, hookFragment, scriptPermission. Three distinct jobs sharing a file: payload copy-action builders, hook command construction, and settings fragments. Splits cleanly into something like `copy-actions.ts` and `hook-wiring.ts`, both named for what they do.

CLAUDE.md documents both files as intentional seams ("`src/types.ts` is the shared model every module and command is typed against"). Any split needs a matching CLAUDE.md edit in the same change, or the docs start lying.

Not urgent. Both files are coherent today and the import churn is real. The reason to track it is that shipping a rule we break is the kind of thing a user notices first.

---

## [KIT-f1ec7e] Decompose doctor() into per-check functions

**Logged:** 2026-08-02

Its ~500-line body with a report() closure blocks unit-testing the individual checks: measureResident budget math, skill/agent description counting, workspace-target scanning, terse-style detection. Ruled out of the test-discipline project as a rewrite rather than a test-driven extraction, which is why doctor's 27 e2e tests could not be thinned.

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

## [KIT-1d28be] src/types.ts and src/modules/shared.ts violate the catch-all-files rule the kit ships

**Logged:** 2026-08-02

code-cleanliness.md forbids types.ts/shared.ts/utils.ts by name, but the installer has both and CLAUDE.md documents src/types.ts as the shared model. Either split them per responsibility (Action/Effect/Ctx into the modules that own them, shared.ts action builders into an action-builders.ts) or carve out a stated exception in the rule. Ships to users, so the inconsistency is visible.

---
