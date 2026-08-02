# Conventions (the parts with no code)

Some of the biggest token wins are pure discipline: Claude Code platform features or authoring
rules, not scripts. There is nothing to copy into a source tree, so you adopt the convention. This
file is the checklist.

Section numbers are stable. Source comments in `src/` and `payload/` cite them, so renumber only
with a matching grep for `CONVENTIONS §`.

## 1. The always-loaded context budget

Auto-loaded context is paid on **every turn of every session**, before any work. It is the root
`CLAUDE.md`, any globless `.claude/rules/*.md` (§6), the skill and agent `description:` frontmatter
that the harness lists every turn, and the machine-local memory index (§5).

`npx claude-kit doctor` measures the in-repo part of that and fails past **4000 tokens or 200 lines**
(`RESIDENT_TOKEN_BUDGET` / `RESIDENT_LINE_BUDGET` in `src/commands/doctor.ts`). Skill and agent
_bodies_ are excluded, because they load on invocation, not on every turn. The memory index lives
outside the repo, so doctor cannot see it. Budget it by hand.

Before adding anything to an always-loaded file, ask: **is this true on every turn?** If it is
scoped to a task type, such as a domain style guide, a feel or balance guardrail, or a workflow only
some changes trigger, it does **not** belong in always-loaded context. It becomes a one-line pointer
("Read X before doing Y") and the body moves to an on-demand file.

A one-time trim of N tokens from the always-loaded surface saves N tokens on every future turn.
That is the highest-multiplier edit available.

### Three tiers

- **Always-loaded:** only always-true routing and safety rules, plus a one-line index of where
  everything else lives.
- **On-demand:** anything scoped to a task type, pulled via a nested-path `CLAUDE.md`, a `paths:`
  scoped rule, or an explicit "Read X before Y" trigger.
- **Pull-only:** large generated references. Never auto-loaded. `grep -n`, then read a tight window.

### `@-import` vs markdown link

- **Markdown link** `[doc](path)` means _pull-when-relevant_. The agent reads it on a trigger.
- **`@-import`** `@path` means _inline-always_. The body expands into context every turn.

Use `@-import` only for small, genuinely always-needed content. The trap is that an `@-import` looks
cheap in the source file but expands to the full body in context. Never `@-import` a big reference
"for convenience."

## 2. Nested CLAUDE.md / STYLE.md (load guidance on demand)

Claude Code injects a directory's `CLAUDE.md` only when the working set is under that directory. Use
it to keep package-specific conventions out of the always-loaded root.

- **Tier 1, root `CLAUDE.md`:** repo-wide facts every session needs (layout, scripts, cross-package
  workflows, tool-use discipline). Keep it lean and don't inline per-package conventions.
- **Tier 2, `<pkg>/CLAUDE.md`:** create one **only** for a package whose local conventions are dense
  enough to get wrong without them. It carries the must-know-before-editing facts inline and links
  the heavier style guide.
- **Tier 3, `<pkg>/STYLE.md`:** long-form, write-time-only conventions. Reference it from the package
  CLAUDE.md with an imperative ("When writing code here, follow STYLE.md") and never inline it, so it
  loads only when you are actually authoring.

**The load-bearing guard:** _"Would an otherwise-competent contributor produce wrong output here
without these specific local rules?"_ If no, **don't add the file.** An empty-calorie `CLAUDE.md` is
pure context cost. Don't cargo-cult "every package gets a CLAUDE.md."

## 3. Subagent model tiering (cost-not-count)

Match the tier to the work, not to the importance of the change.

**Cheap tier.** Reviewer, changeset-writer, and backlog-reviewer agents do mechanical,
rubric-driven, narrow-tool work: a fixed procedure over a grep-located range, returning a small
verdict. Put `model: haiku` (or the cheapest capable tier) in their frontmatter, which the kit's
agents already do, and add `effort: low` for the most mechanical ones. The kit sets both on
`changeset-writer` and `backlog-reviewer`.

**Default tier.** Reserve it for open-ended judgement. The kit's `task-worker` is `model: sonnet`
with `effort: medium` precisely because implementing a slice is not rubric-driven, and the shipped
`debugger` template leaves `model` unset so it inherits the session model.

This is your highest-frequency fan-out, since every non-trivial change spawns reviewers and a
changeset-writer, so routing it to a cheaper tier is the single biggest spend reduction available
without changing any behavior.

The same applies inside **workflows**. `agent(prompt, { model, effort })` accepts per-call
overrides. Default to omitting them so the agent inherits the session model. Set `model: 'haiku'` or
`effort: 'low'` only for cheap mechanical stages (find, list, transform), and reserve higher tiers
for the hardest verify and judge stages.

## 4. Read-only fan-out discipline

An agent that audits code gets **only** `Read, Grep, Glob`, so it is structurally incapable of side
effects and the orchestrator never has to supervise it. The kit's `reviewer` and `persona-auditor`
templates ship exactly that grant.

Some agents genuinely need `Bash`, and the tool grant alone will not constrain them. An archivist
runs git plus the ledger script, `changeset-writer` runs `changeset-write.mjs`, and
`backlog-reviewer` runs `backlog-log.mjs list` to dedupe across ledgers. For those, the read-only
guarantee moves into the body as an explicit constraint ("never edit source", "never hand-edit the
ledger, always go via the script"), and the script is the only writer.

Every agent body should carry a tool-call budget (`≤ 6-8 tool calls`, "grep -n then Read with
offset+limit"). That bounds the _subagent's_ context, not just the orchestrator's.

When fanning out from a workflow, pin the read-only subagent type so review agents can't write, and
because parallel writers race a package-wide lint Stop-hook.

## 5. File-based memory (Claude Code feature, conventions only)

Persistent cross-session memory lives at `~/.claude/projects/<encoded-cwd>/memory/`. It is
machine-local, per-developer, and not in git. Nothing to copy, so adopt the discipline:

1. **One fact per file.** Granularity is what makes lazy-load cheap.
2. **Frontmatter:** `name` (kebab, matching the filename), `description` (one sentence, and this is
   the routing key), a `metadata.type` drawn from a small fixed vocabulary, and provenance. The
   vocabulary matters more than its exact terms. Pick four or five, write them down, and don't grow
   the list ad hoc.
3. **Body:** the fact, then **Why:** (what failure motivated it) and **How to apply:**. Cross-link
   siblings with `[[wikilink]]`.
4. **Index (`MEMORY.md`):** one bullet per fact, as `- [Title](file.md) — terse gist`. It is
   auto-loaded every session, so it has a hard budget. One line each, prune and merge ruthlessly, and
   make the gist specific enough to decide relevance **without** opening the file.
5. **Recall rule (put in CLAUDE.md):** "The index is auto-loaded, the entries are not. Open a linked
   file only when its one-line description is load-bearing. Don't speculatively open memory files."
6. **Staleness:** memory is point-in-time. Re-verify any file:line or code-behavior claim against
   current code before asserting it.
7. **What earns a memory:** durable, re-derivation-prone conclusions and user corrections. Not
   transient task state, and not anything that belongs in a checked-in guardrail doc. Put that in the
   doc instead, so it is versioned and shared with teammates.

## 6. Guardrail / authoritative-source docs

For each axis the repo keeps re-deriving (architecture, API conventions, security, voice, balance),
write a small `.claude/rules/<topic>.md`. The kit ships a starting point at
`.claude/kit-templates/rules/GUARDRAIL.md.template`, restored by `npx claude-kit update` if it goes
missing. Each doc carries terse locked decisions **with their rationale**, a "if a change is in
tension with this, the change is wrong" precedence line, and `description` frontmatter. The payoff is
converting open-ended judgement into a cheap lookup against a locked answer, which avoids the most
expensive failure: work that points the wrong way and gets reverted.

**`.claude/rules/*.md` is auto-loaded, and the frontmatter decides when** (verified against Claude
Code 2.1.220). A rule file **without** `paths:` is project memory, resident on _every_ turn, whether
or not CLAUDE.md points at it. A rule file **with** `paths:` globs is conditional and loads only when
a matching file is in the working set:

```yaml
---
paths:
  - '**/*.ts'
  - 'packages/api/**'
---
```

So give any rule scoped to a file type or area a `paths:` list. That list _is_ its conditional
trigger, which makes a CLAUDE.md pointer redundant. Reserve globless rule files for the rare axis
that is truly true on every turn. A globless guardrail doc silently spends the always-loaded budget
from §1, and `doctor` flags it. If you want a doc pull-only instead, keep it out of `.claude/rules/`
and link it from CLAUDE.md.

The kit's own `code-comments` and `prose-voice` modules are worked examples of the pattern: both ship
as `paths:`-scoped rules with no hook and no CLAUDE.md pointer. `code-cleanliness` goes further,
splitting a `paths:`-scoped rule from a pull-only `.claude/reference/design-principles.md` that the
rule links to instead of restating. `testing` shows the axis cutting the other way: its `paths:` list
holds test suffixes rather than source ones, so the rule is resident only while a test is open.

## 7. Generated-reference snapshots and pull-only access

If the source of truth is scattered across many files (docs/, a split spec, a schema dir), a
deterministic generator can stitch them into one grep-able `.claude/reference/<name>.md` with a
stable heading skeleton and a `GENERATED — do not edit, regenerate with <cmd>` header.

Two kit modules cover the reusable half of this:

- **`regen`** wires a PostToolUse(Edit|Write) hook that re-runs a user-owned generator when an edited
  file matches a target's `regen { sourceGlob, command }` in `kit.config.json`. The generator is
  yours, and the freshness wiring is the kit's.
- **`read-guard`** enforces the pull-only access rule, redirecting unbounded whole-file reads of
  generated or oversized files toward `grep` or a windowed read. Reads that already carry
  `offset`/`limit` pass untouched.

The transform logic stays bespoke per corpus. The _wrapper_ (header, canonical ordering, regen hook,
grep-don't-read-whole access rule) is the reusable part. A snapshot is only worth building when one
search angle genuinely can't find things across the corpus, and it should only ever be pull-loaded,
never auto-loaded.

## 8. What stays yours

The kit packages disciplines, not domain knowledge. These stay per-repo by design, and no future
module will absorb them:

- **Guardrail doc content** (§6). The kit ships the template and the loading mechanics. The locked
  decisions are yours, and a guardrail doc someone else wrote is worthless.
- **Reviewer authoritative sources** (§4). Reviewer agents install as explicit DRAFTs, and `doctor`
  keeps flagging them until you fill in what each area's source of truth actually is. A DRAFT
  reviewer's verdict is not trustworthy.
- **Generator transforms** (§7). The corpus shape is repo-specific.
- **Nested per-package conventions** (§2). Only you know which packages are dense enough to earn a
  file.
- **`kit.config.json` targets, prefixes, and verify commands.** Detection seeds them, but the file,
  not detection, is the contract.

Skills are the right home for a recurring multi-step workflow, since they move the recipe out of
always-loaded CLAUDE.md into an on-demand `.claude/skills/<name>/SKILL.md`. Note that skills
supersede flat `.claude/commands/*.md` files.

## 9. Context-hygiene checklist (platform features, no code)

Each of these is a standing habit, not a script:

- **`/context` and `/usage`** show what's eating the window and the session cost. Check before
  blaming the model.
- **`/clear` between unrelated tasks.** Stale context is paid on every following turn.
- **Disable unused MCP servers** (`/mcp`). CLI tools (`gh`, `aws`) are cheaper than MCP equivalents,
  and tool definitions cost context even when deferred.
- **Keep the always-loaded surface under ~200 lines**, the same `RESIDENT_LINE_BUDGET` doctor checks
  in §1. Everything task-scoped moves to a skill, a nested CLAUDE.md, or an on-demand doc (§1–§2).
- **Subagents for high-volume operations** such as long test runs, log spelunking, and wide greps.
  The transcript stays in the subagent, and only the verdict returns.

## 10. Output and input compression (what's real, as of mid-2026)

- **Response-token compression is a style problem.** The kit's opt-in `terse-style` output style
  (adapted from caveman, MIT) cuts ~50–70% of response tokens by dropping filler and prose, at a
  readability cost. Good for grind sessions, wrong for explanations you'll reread.
- **Authored prose is a separate lever.** `prose-voice` is a `paths:`-scoped rule covering the
  markdown the agent writes (changesets, plans, docs, backlog entries) rather than its chat replies,
  so it composes with any output style. It buys clarity more than tokens. Splitting an em-dashed
  clause into two sentences is roughly token-neutral.
- **Tool-output compression via hooks isn't reliable.** PostToolUse output replacement
  (`updatedToolOutput`) is not honored on current Claude Code, verified inert on 2.1.208, where the
  hook runs but the model still receives the raw output. The kit therefore ships no tool-output
  compressor. Claude Code's own large-output persistence covers the worst case, and the durable lever
  stays subagents: route high-volume reads and runs through one so the transcript never hits the main
  thread.
