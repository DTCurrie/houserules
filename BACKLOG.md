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
