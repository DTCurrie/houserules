# Backlog — repo root

Deferred work. Add entries via `.claude/scripts/backlog-log.mjs`; remove on resolution.

## [CLAUDEKIT-4e98d7] render.mjs fixDefaultsFor breaks single-package pnpm installs

**Logged:** 2026-07-03
**Chat:** c6e0cf3d-b25f-4fdb-94fb-af4abfce496f

cli/render.mjs fixDefaultsFor emits fix.filterFlag '--filter' regardless of monorepo status, and cli/detect.mjs detectFixCommands never selects a plain 'format' script (only fix/lint:fix/format:fix). Result: a single-package pnpm repo gets a broken lint-fix config — 'pnpm --filter <pkg> lint:fix' fails (no workspace) and prettier never auto-runs. Fix: filterFlag '' when not a monorepo, and allow a 'format' fixer fallback; add a regression test + changeset. Surfaced by dogfooding (scripts/dogfood-link.mjs hand-authors the correct single-package config as a workaround). Refs cli/render.mjs:20-51, cli/detect.mjs:17-29.

---
