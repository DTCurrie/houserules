# Conventions (the parts with no code)

Some of the biggest token wins are pure discipline — Claude Code platform features or authoring
rules, not scripts. There's nothing to copy into a source tree; you adopt the convention. This file
is the checklist.

## 1. The always-loaded context budget

Auto-loaded context (root `CLAUDE.md` + the memory index + any harness-injected guardrail) is paid
on **every turn of every session**, before any work. Treat it as a hard budget (~3-4K tokens is a
sane target).

Before adding anything to an always-loaded file, ask: **is this true on every turn?** If it's scoped
to a task type — a domain style guide, a feel/balance guardrail, a workflow only some changes trigger
— it does **not** belong in always-loaded context. It becomes a one-line pointer ("Read X before
doing Y") and the body moves to an on-demand file.

A one-time trim of N tokens from the always-loaded surface saves N tokens × every future turn. That's
the highest-multiplier edit available.

### Three tiers

- **Always-loaded:** only always-true routing/safety rules + a one-line index of where everything
  else lives.
- **On-demand:** anything scoped to a task type — pulled via a nested-path `CLAUDE.md` or an explicit
  "Read X before Y" trigger.
- **Pull-only:** large generated references — never auto-loaded; `grep -n` then read a tight window.

### `@-import` vs markdown link

- **Markdown link** `[doc](path)` = *pull-when-relevant*. The agent reads it on a trigger.
- **`@-import`** `@path` = *inline-always*. The body expands into context every turn.

Use `@-import` only for small, genuinely always-needed content. The trap: an `@-import` looks cheap
in the source file but expands to the full body in context — never `@-import` a big reference "for
convenience."

## 2. Nested CLAUDE.md / STYLE.md (load guidance on demand)

Claude Code injects a directory's `CLAUDE.md` only when the working set is under that directory. Use
it to keep package-specific conventions out of the always-loaded root.

- **Tier 1 — root `CLAUDE.md`:** repo-wide facts every session needs (layout, scripts, cross-package
  workflows, tool-use discipline). Keep it lean; don't inline per-package conventions.
- **Tier 2 — `<pkg>/CLAUDE.md`:** create one **only** for a package whose local conventions are dense
  enough to get wrong without them. Carries the must-know-before-editing facts inline; links the
  heavier style guide.
- **Tier 3 — `<pkg>/STYLE.md`:** long-form, write-time-only conventions. Referenced from the package
  CLAUDE.md with an imperative ("When writing code here, follow STYLE.md"); never inlined, so it loads
  only when actually authoring.

**The load-bearing guard:** *"Would an otherwise-competent contributor produce wrong output here
without these specific local rules?"* If no, **don't add the file** — an empty-calorie `CLAUDE.md` is
pure context cost. Don't cargo-cult "every package gets a CLAUDE.md."

## 3. Subagent model tiering (cost-not-count)

The reviewer/changeset-writer/backlog-reviewer agents do mechanical, rubric-driven, narrow-tool
work: a fixed procedure over a grep-located range, returning a small verdict. Put `model: haiku`
(or the cheapest capable tier) in their frontmatter — the kit's agents already do — and add
`effort: low` for the most mechanical ones (the kit sets it on changeset-writer and
backlog-reviewer). Reserve the default model and effort for genuinely open-ended judgement.

This is your highest-frequency fan-out (every non-trivial change spawns reviewers and a
changeset-writer), so routing it to a cheaper tier is the single biggest spend reduction
available without changing any behavior.

The same applies inside **workflows**: `agent(prompt, { model, effort })` accepts per-call
overrides. Default to omitting them (inherit the session model); set `model: 'haiku'` /
`effort: 'low'` only for cheap mechanical stages (find, list, transform), and reserve higher
tiers for the hardest verify/judge stages.

## 4. Read-only fan-out discipline

Reviewers and personas must get **only** `Read, Grep, Glob` so they're structurally incapable of side
effects — the orchestrator never has to supervise them. Archivists need `Bash` (git + the script), so
keep their "never edit src/, never hand-edit the changelog" constraints in the body; the tool grant
alone won't stop them. Every agent body should carry a tool-call budget (`≤ 6-8 tool calls`,
"grep -n then Read with offset+limit") — that bounds the *subagent's* context, not just the orchestrator's.

When fanning out from a workflow, pin the read-only subagent type so review agents can't write — and
because parallel writers race a package-wide lint Stop-hook.

## 5. File-based memory (Claude Code feature — conventions only)

Persistent cross-session memory lives at `~/.claude/projects/<encoded-cwd>/memory/` (machine-local,
per-developer, not in git). Nothing to copy; adopt the discipline:

1. **One fact per file.** Granularity is what makes lazy-load cheap.
2. **Frontmatter:** `name` (kebab, = filename), `description` (one sentence — this is the routing
   key), `metadata.type` (`feedback` | `decision` | `gotcha` | `convention`), provenance.
3. **Body:** the fact, then **Why:** (what failure motivated it) and **How to apply:**. Cross-link
   siblings with `[[wikilink]]`.
4. **Index (`MEMORY.md`):** one bullet per fact, `- [Title](file.md) — terse gist`. Auto-loaded every
   session → a hard budget. One line each; prune/merge ruthlessly; make the gist specific enough to
   decide relevance **without** opening the file.
5. **Recall rule (put in CLAUDE.md):** "The index is auto-loaded; the entries are not. Open a linked
   file only when its one-line description is load-bearing. Don't speculatively open memory files."
6. **Staleness:** memory is point-in-time. Re-verify any file:line / code-behavior claim against
   current code before asserting it.
7. **What earns a memory:** durable, re-derivation-prone conclusions and user corrections — not
   transient task state, and not anything that belongs in a checked-in guardrail doc (put it there
   instead, so it's versioned and shared with teammates).

## 6. Guardrail / authoritative-source docs

For each axis the repo keeps re-deriving (architecture, API conventions, security, voice, balance),
write a small `.claude/rules/<topic>.md` (see `templates/rules/GUARDRAIL.md.template`): terse locked
decisions **with their rationale**, a "if a change is in tension with this, the change is wrong"
precedence line, and a `description` frontmatter. List it in CLAUDE.md with a **conditional trigger**,
not "always read". The payoff is converting open-ended judgement into a cheap lookup against a locked
answer — and avoiding the most expensive failure, work that points the wrong way and gets reverted.

## 7. Generated-reference snapshot (optional, for fragmented authoritative corpora)

If the source of truth is scattered across many files (docs/, a split spec, a schema dir), a
deterministic generator can stitch them into one grep-able `.claude/reference/<name>.md` with a stable
heading skeleton and a "GENERATED — do not edit; regenerate with <cmd>" header. Wire a PostToolUse
hook to re-run the generator when a source file is edited. The transform logic is bespoke per corpus;
the *wrapper* (header, canonical ordering, regen hook, "grep-don't-read-whole" access rule) is the
reusable part. Only worth it when one search angle genuinely can't find things across the corpus —
and only ever pull-loaded, never auto-loaded.

## 8. Recommended additions not yet packaged as code

Worth building per-repo as the need arises (kept out of the kit to avoid half-built, repo-specific code):

- **Skills for recurring multi-step workflows** (`/review-change`, `/sweep`) — moves the recipe
  out of always-loaded CLAUDE.md into an on-demand `.claude/skills/<name>/SKILL.md`. (The kit
  ships `/backlog-add` and `/changeset` as worked examples; note skills supersede flat
  `.claude/commands/*.md` files.)
- **`verify-changed` wrapper** — reuse `lint-format-fix`'s changed-path→package mapping, walk the
  dependency DAG, and run lint/check/test only on changed packages + their dependents, instead of a
  full-repo sweep.

## 9. Context-hygiene checklist (platform features, no code)

Each of these is a standing habit, not a script:

- **`/context` and `/usage`** show what's eating the window and the session cost — check before
  blaming the model.
- **`/clear` between unrelated tasks** — stale context is paid on every following turn.
- **Disable unused MCP servers** (`/mcp`) — CLI tools (`gh`, `aws`) are cheaper than MCP
  equivalents; tool definitions cost context even when deferred.
- **Keep CLAUDE.md under ~200 lines** — everything task-scoped moves to a skill, a nested
  CLAUDE.md, or an on-demand doc (see §1–2).
- **Subagents for high-volume operations** — long test runs, log spelunking, wide greps: the
  transcript stays in the subagent; only the verdict returns.

## 10. Output/input compression (what's real, as of mid-2026)

- **Response-token compression is a style problem.** The kit's opt-in `terse-style` output
  style (adapted from caveman, MIT) cuts ~50–70% of response tokens by dropping filler and
  prose — at a readability cost. Good for grind sessions, wrong for explanations you'll reread.
- **Tool-output compression is a spill problem.** The kit's experimental `output-compactor`
  hook keeps oversized Bash output on disk and hands the model head+tail+pointer
  (compress-cache-retrieve). Everything stays grep-able.
- **headroom** (headroomlabs-ai/headroom) is the heavyweight option: a local Python proxy
  (`headroom wrap claude`) doing content-aware input compression. Know before adopting: the
  `headroom-ai` npm package is a **client for that proxy, not a standalone compressor** — there
  is no pure-Node path. It composes with the kit (the kit reduces what enters context; headroom
  compresses what does), but it's a separate runtime you operate yourself.
