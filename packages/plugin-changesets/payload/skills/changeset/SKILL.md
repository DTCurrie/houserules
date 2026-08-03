---
name: changeset
description: Record a pending release note (changeset) for the packages a change touched. Use after completing a user-visible change, before the user commits. Changesets accompany the change, not the release.
argument-hint: [pkg[:level] ...] ["summary"]
allowed-tools: Bash(node .claude/scripts/changeset-write.mjs:*), Bash(git status:*), Bash(git diff:*), Read, Grep
---

Record what this change means for the next release. Arguments (optional overrides): $ARGUMENTS

1. **Identify touched packages.** `git status --porcelain` and `git diff --name-only`, mapped
   through the targets in `.claude/kit.config.json`.
2. **Pick the bump level per package** (semver):
   - `patch`: fixes, internal refactors with no API change. The default.
   - `minor`: new user-facing capability, backwards-compatible.
   - `major`: breaking change. **Confirm with the user before recording a major.**
3. **Write the summary.** This is the canonical spec, and the `changeset-writer` agent follows it
   too.
   - **One short sentence**, 15 words or fewer, in changelog voice, naming what changed as the
     package's users read it.
   - Describe the change, not its mechanism, its rationale, or what stayed the same.
   - No semicolons and no second clause. "So that…", "whenever…", "because…", and ", and also…"
     all mean you are packing in too much. A run-on is still too much even when it's one sentence.
   - Use exact names and numbers from the diff, not from memory.
   - Put any backlog IDs it resolves in parentheses.

   Good: `Fix compact tool output hook to reduce noise.`

   Too much: `changeset-write.mjs now authors with @changesets/write whenever changesets is
installed, so files match the version; the zero-dep writer remains as fallback.`
   → `Changeset authoring uses the repo's installed changesets writer when available.`

4. **Record it.** The script validates package names against the real workspace.
   ```
   node .claude/scripts/changeset-write.mjs --pkg <name>:<level> [--pkg <name>:<level> ...] --summary "<summary>"
   ```
   Nothing release-worthy (tests, tooling, docs)? Record that decision instead:
   ```
   node .claude/scripts/changeset-write.mjs --empty --summary "<why no release is needed>"
   ```
5. **Report** the created `.changeset/*.md` path and what it declares.

Never hand-edit `CHANGELOG.md`, which `changeset version` generates at release time, and never
hand-write `.changeset/*.md`. Always go through the script.
