---
name: blast-radius
description: Map the blast radius of a change ONCE and archive it — fan out read-only explorer subagents over a change's consumers, then write a dated, disclaimer-headed impact map to .claude/plans/ (per-file symbol/consumer/risk list + a HIGH/MED/LOW completeness self-audit) so downstream sessions grep the artifact instead of re-running the survey. Use before a wide or risky change to see what it touches.
argument-hint: <the change / symbol / module whose impact to map>
allowed-tools: Bash, Read, Grep, Glob, Agent, Write
---

Map — and **archive** — the blast radius of: **$ARGUMENTS**

A blast-radius survey is expensive to run and cheap to re-read. Run the read-only fan-out **once**,
write the result to a dated artifact under `.claude/plans/`, and let every later session `grep` that
file instead of re-fanning the whole survey.

## 1. Name the surface

Identify the exact thing changing: the exported symbol(s), file(s), route, config key, or schema.
Get the concrete names to search for — a blast-radius map is only as good as the seeds you fan out on.

## 2. Fan out read-only explorers — once, in one message

Dispatch parallel read-only `Agent`/Explore calls, one per search angle, so no single agent holds the
whole picture and you don't serialize the survey:

- **by symbol** — direct importers/callers of each changed export.
- **by string** — config keys, route paths, feature flags, magic strings the change renames or removes.
- **by contract** — types/enums/interfaces the change alters, and their structural consumers.
- **by boundary** — cross-package edges (a monorepo dependent that imports the changed package).

Each explorer returns a compact list — `file:line → how it consumes the surface → risk if it breaks`.
They are read-only; they map, they don't edit.

## 3. Write the dated artifact

Write `.claude/plans/blast-radius-<slug>-<YYYY-MM-DD>.md` (stamp the date with `date +%Y-%m-%d` and the
commit with `git rev-parse --short HEAD`). It **must** open with a staleness disclaimer and carry these
sections:

```markdown
# Blast radius — <surface> — <YYYY-MM-DD>

> ⚠️ Snapshot at commit `<sha>` on <date>. Cited lines drift as code changes — re-verify each before
> relying on it; treat this as a map, not ground truth. Regenerate with `/blast-radius <surface>`.

## Surface

<the exact symbols/files/keys this maps>

## Impact by file

- `path:line` — <symbol/consumer> — <how it uses the surface> — **risk:** <what breaks if changed>
- ...

## Cross-package / boundary impact

<dependent packages or services that consume the surface, if any>

## Completeness self-audit

- **Coverage:** HIGH | MED | LOW — <which angles were exhausted, which were sampled>
- **Gaps:** <search angles not run, dynamic/reflective usages a static search can miss, generated code>
```

## 4. Hand back the artifact, not the survey

Tell the user the map is at `.claude/plans/blast-radius-<slug>-<date>.md` and give the one-line
headline (N consumers across M files, coverage HIGH/MED/LOW, the sharpest risk). Do **not** paste the
whole map into this context — the point is that it lives on disk. `.claude/plans/` is gitignored by the
plans module, so the artifact is local living state, not a commit.

## Notes

- The reusable kernel is the **artifact shape + read-only fan-out + staleness disclaimer + freshness
  cue** — not repo-specific search logic. Tune the seed patterns in step 1/2 to your codebase; keep
  the shape.
- Completeness honesty matters more than breadth: a `LOW` coverage with named gaps is more useful than
  a confident map that silently missed the dynamic call sites.
