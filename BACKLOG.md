# Backlog — repo root

Deferred work. Add entries via `.claude/scripts/backlog-log.mjs`; remove on resolution.

## [KIT-a49714] Revisit TypeScript 7 once typescript-eslint supports it

**Logged:** 2026-07-31
**Chat:** 3c00b063-c422-4b20-8928-e969f10ea399

Pinned typescript to ^6.0.3 in phase 1 of kit-v2: typescript-eslint@8.65 peers 'typescript >=4.8.4 <6.1.0' and hard-errors on TS 7.0 (the Go port), with no side-by-side story for eslint. Tracking issue: typescript-eslint#10940. Bump to TS 7 when that lands.

---

## [KIT-9b7155] Orchestrate skill should specify a per-wave status-table format

**Logged:** 2026-07-31
**Chat:** 3c00b063-c422-4b20-8928-e969f10ea399

User liked the mid-run status table the orchestrator emitted (columns: Slice | Owns | State, with done/running/pending markers). Add it to payload/skills/orchestrate/SKILL.md as the prescribed shape for status updates between waves, so every /orchestrate run surfaces progress the same way instead of ad-hoc prose.

---
