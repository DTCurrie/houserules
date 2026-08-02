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
