# Backlog — repo root

Deferred work. Add entries via `.claude/scripts/backlog-log.mjs`; remove on resolution.

## [CLAUDEKIT-a49714] Revisit TypeScript 7 once typescript-eslint supports it

**Logged:** 2026-07-31
**Chat:** 3c00b063-c422-4b20-8928-e969f10ea399

Pinned typescript to ^6.0.3 in phase 1 of kit-v2: typescript-eslint@8.65 peers 'typescript >=4.8.4 <6.1.0' and hard-errors on TS 7.0 (the Go port), with no side-by-side story for eslint. Tracking issue: typescript-eslint#10940. Bump to TS 7 when that lands.

---

## [CLAUDEKIT-6d85f1] Build never cleans dist/ and payload-dist/, so removed sources leave published orphans

**Logged:** 2026-08-03
**Chat:** eabeb5d0-2928-4332-a1a6-f42cc0fae23e

`pnpm build` runs `tsc` over existing output dirs without clearing them. A deleted source file leaves its compiled artifact behind and `files` ships it.

Proven during the workspace conversion: the 1.3.1 pack list carried `dist/types.js`, `dist/types.d.ts`, `dist/modules/shared.js`, `dist/modules/shared.d.ts` (plus maps) and `payload-dist/scripts/backlog-inject.mjs`. None have a source file. A clean rebuild produces 322 files where the stale tree produced 332.

The stale artifact also masked a real test failure. `payload/__test__/execution.test.ts` listed `backlog-inject.mjs` in `HOOKS_THAT_MUST_NEVER_CRASH` after the script was renamed to `ledger-inject.mjs`, and the suite passed only because the orphan was still on disk.

Fix: have `build` and `build:payload` remove their outDir first, or add a `clean` step they depend on.

---

## [CLAUDEKIT-c3040b] decisions module should write its ledger under .claude/, not the repo root

**Logged:** 2026-08-03
**Chat:** eabeb5d0-2928-4332-a1a6-f42cc0fae23e

The `decisions` module renders `DECISIONS.md` at the repo root today (`.claude/scripts/decision-log.mjs`, `render`). Wrong home for it.

The file is append-only and never retires, so it grows without bound. Its audience is agents resolving an ID or checking whether a design was already settled, not humans browsing the repo. A large, ever-growing, machine-oriented file at the root competes for attention with README and CONTRIBUTING, and it will show up in every directory listing and PR diff.

Move the rendered surface under `.claude/` (for example `.claude/decisions/DECISIONS.md`), matching where `.claude/decisions.log` already lives. Check the same question for `BACKLOG.md`, which has the same growth profile and the same audience.

Needs care on three fronts: the `--scope` path filter, the `/decide` skill's "nearest ledger" lookup, and existing installs whose file is already at the root. A move that strands an existing ledger is worse than leaving it.

Also needs to handle monorepo setups.

---

## [CLAUDEKIT-4b74a6] Second-harness support: research done, verdict is defer

**Logged:** 2026-08-03
**Chat:** cf671b02-c19e-40a8-8cbb-8cf239ec142c

Full analysis in `docs/second-harness-spike.md`. Summary so this entry stands alone:

**Verdict: defer.** Do not build a `harness` config field speculatively.

The prose half of the kit already travels for free. Cursor reads `.claude/skills/` directly for compatibility, verified at https://cursor.com/docs/skills ("For compatibility, Cursor also loads skills from Claude and Codex directories"). Skills and rules are the cheap majority of the value and they port with zero kit changes.

The mechanism half does not travel. Hooks, the Bash guard, settings merging, and statusline depend on `.claude/settings.json`'s shape, and no surveyed harness shares it closely enough for a path-and-format profile to bridge. That is a second implementation, not a mapping. 7 of 15 core modules sit in that bucket.

**Revisit when** a second harness ships a hook mechanism resembling Claude Code's, or when `.agents/` consolidates enough that the config directory becomes a variable rather than a constant. Until then a `harness` field would be shaping a seam for a shape nothing else has.

If it is ever done, the coupling is concentrated: the `dest` strings in `packages/cli/src/modules/copy-actions.ts`, `SHARED_HOST_FILES` in `packages/cli/src/plan.ts`, and `packages/cli/src/modules/hook-wiring.ts`.

---
