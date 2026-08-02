# Backlog — repo root

Deferred work. Add entries via `.claude/scripts/backlog-log.mjs`; remove on resolution.

## [CLAUDEKIT-a49714] Revisit TypeScript 7 once typescript-eslint supports it

**Logged:** 2026-07-31
**Chat:** 3c00b063-c422-4b20-8928-e969f10ea399

Pinned typescript to ^6.0.3 in phase 1 of kit-v2: typescript-eslint@8.65 peers 'typescript >=4.8.4 <6.1.0' and hard-errors on TS 7.0 (the Go port), with no side-by-side story for eslint. Tracking issue: typescript-eslint#10940. Bump to TS 7 when that lands.

---

## [CLAUDEKIT-15f1e4] Treat rule frontmatter as user-owned and the rule body as kit-owned

**Logged:** 2026-08-02
**Chat:** ea2954f3-8539-4ce2-93b5-e7ea6f264056

The kit's own `testing` advise text tells users to trim the rule's `paths:` frontmatter, so a
repo that follows the advice permanently diverges from the shipped rule. Doctor no longer warns
about it (a settled edit is a readout, and only a `conflict` is a warning), but the divergence
itself remains: the whole file is kit-owned, so the trimmed rule stops tracking improvements to
the rule BODY unless the user hand-merges.

The fix is the inversion `RegionAction` already encodes for CLAUDE.md, applied the other way
round. Hash only the body below the closing `---` in the manifest, and have `--fix` and `update`
splice a fresh body under whatever frontmatter the user has. Trimming `paths:` then stops being
drift at all, and rule bodies stay update-refreshable forever.

Needs a companion doctor check for a rule file left with no `paths:` key at all. Claude Code
loads such a rule on every turn, which is the exact failure `copy-actions.ts`'s `rule()` doc
warns about, and this change would otherwise bless it silently.

Rejected: a `rules.<id>.paths` key in kit.config.json. It adds config surface for something the
file already expresses, and does nothing for users who already trimmed by hand.

---
