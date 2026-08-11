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

`npx agent-kit doctor` measures the in-repo part of that and fails past **4000 tokens or 200 lines**
(`RESIDENT_TOKEN_BUDGET` / `RESIDENT_LINE_BUDGET` in `src/commands/doctor/resident-surface.ts`). Skill and agent
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
`.claude/kit-templates/rules/GUARDRAIL.md.template`, restored by `npx agent-kit update` if it goes
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

**`paths:` is a working-set trigger, not a write-intent trigger, and a plain Read is enough to fire
it.** The docs state it directly: path-scoped rules trigger when Claude reads a matching file, not
on every tool use. So a rule scoped to `**/*.md` loads on a turn that only answered a question after
reading a backlog entry. There is no tool filter and no read-versus-write gate in rule frontmatter,
`paths` is the only field, verified against 2.1.220. A `PreToolUse` hook can inject context and does
reach the model, but it lands next to the tool result, so it cannot shape the edit that triggered
it. Budget for the rule loading on reads, and pick globs on that basis rather than on where writes
happen.

**If one rule defers to another, the target's `paths:` must cover the source's.** A rule that says
"see `other.md` for X" is a dangling pointer on any file where the target is not loaded. `prose-voice`
is the worked example of getting this wrong and then right: it owns sentence-level voice, both
`code-comments` and `testing` defer to it, and its `paths:` list was markdown-only, so on every
source file the comment rule pointed at a rule that was not in context. The fix was to widen the
target, not narrow it. Check the direction of every cross-rule reference before trimming a glob
list.

The kit's own `code-comments` and `prose-voice` modules are worked examples of the pattern: both ship
as `paths:`-scoped rules with no hook and no CLAUDE.md pointer, over the same source extensions so
the deference between them resolves. `code-cleanliness` goes further,
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

### The one exception: an external published standard

"Domain knowledge stays yours" is about knowledge that differs per repo. A **published external
standard** does not. WCAG 2.2 is the same 87 success criteria in every repo on earth, it is
versioned by someone else, and no team's copy is more authoritative than another's. Shipping it
is closer to shipping a lookup table than to shipping someone else's architecture decisions.

`@agent-kit/plugin-accessibility` is the worked example, and it shows the shape such a plugin has
to take:

- **Generated from the upstream source at a pinned version, never hand-authored.** A hand-written
  paraphrase of a standard is unverifiable and goes stale silently. Regenerating must be
  byte-identical, and the generator must ship in the repo, not in the package.
- **Pull-only** (§7). A standard is too big to auto-load, and almost none of it is relevant to any
  one change.
- **Routing is the actual product.** The corpus is inert without something that answers "which
  part of this applies to my change". That router is the kit's own work, and it is the part worth
  writing.
- **The licence travels with it.** Check what redistribution the standard permits before shipping
  a line of it, and carry the required notice in the generated file and the package `LICENSE`.

The bar is: published, externally versioned, identical across repos, and licensed for
redistribution. A standard that fails any of those is domain knowledge again, and it stays yours.

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

- **Shortening replies is a style problem. Cutting your bill is not.** The kit's opt-in
  `output-prose` output style (adapted from caveman, MIT) drops filler and packaging for shorter
  replies, at a readability cost. It does that well. **It does not reduce token spend.** The words
  in a reply are a small part of what a session costs, next to the system prompt, the files read,
  and the conversation replayed on every turn, and the style's own text is added to every request.
  caveman's README says the same of theirs. Two structural limits compound it: an output style is
  read once at session start, and it reaches the main thread only, since a subagent runs its own
  system prompt. Route work through subagents and the style never touches it.
- **A style that deletes can delete the answer.** An earlier version of this style dropped a fact
  the user had explicitly asked for on an agentic task, while writing correct code and passing
  tests. The unstyled model got it right and the styled one did not. Compression scales with tool
  use, and so does the cost of over-compressing, because the reply is the only human-readable
  record of what the tools did. The fix is a floor on the final message: it carries the outcome,
  what changed, and where. Tracked as `AGENTKIT-7fd33a`.
- **Compression rules delete function words, and some function words carry the claim.** A rule set
  that cuts articles, subjects, and hedges is training a habit that does not distinguish "just"
  from "not". A dropped negation inverts a sentence and still reads as clean terse output, so
  nothing downstream catches it. Protect negations and units by name, alongside code and paths.
- **Measure the artifact you ship, not the one you tested.** This style has been measured three
  times. The first figure was never measured at all. The second used a broken metric. The third
  described a version that a same-day edit had already replaced. Re-run after editing the
  artifact, or the numbers quietly describe something else. **The kit publishes no savings
  figure**, and the docs describe what to expect rather than what was measured.
- **The withdrawn measurement is worth reading before building another one.** The harness summed
  each API response's `output_tokens` once per transcript content-block record. Claude Code writes
  one record per block and repeats the whole response's usage on each, so a response mixing prose
  with a tool call had its tool-call tokens booked as prose. The bias was one-sided: the unstyled
  arm writes a preamble before tool calls and the style suppresses exactly that, so the
  contamination landed almost entirely on the control arm and inflated the apparent effect. The
  premise was "checked" by scanning for records that mix text and `tool_use`, finding none, at the
  one level where the per-block split makes that impossible. **A verification that cannot fail is
  not a verification.** Tracked as `AGENTKIT-b0e8a1`.
- **Authored prose is a separate lever.** `prose-voice` is a `paths:`-scoped rule covering the prose
  the agent writes (changesets, plans, docs, backlog entries, and the sentences inside code comments)
  rather than its chat replies, so it composes with any output style. It buys clarity more than
  tokens. Splitting an em-dashed clause into two sentences is roughly token-neutral.
- **Tool-output compression via hooks isn't reliable.** PostToolUse output replacement
  (`updatedToolOutput`) is not honored on current Claude Code, verified inert on 2.1.208, where the
  hook runs but the model still receives the raw output. The kit therefore ships no tool-output
  compressor. Claude Code's own large-output persistence covers the worst case, and the durable lever
  stays subagents: route high-volume reads and runs through one so the transcript never hits the main
  thread.

## 11. Plugin surface semver policy

`@agent-kit/api` (`PluginApi`, `Plugin`, `definePlugin`, `PayloadBuilders`, and the `Action`
union) is public API the moment a plugin depends on it. A plugin declares
`peerDependencies: { "@agent-kit/api": ">=0.0.0 <1.0.0" }`, so a breaking change to this
surface breaks every plugin still on that range. See
[README.md](README.md#writing-a-plugin) for what a plugin author sees.

- **Minor.** Adding an optional field to `PluginApi`. Adding a new `Action` kind. Adding a new
  builder to `PayloadBuilders`. Anything a plugin can ignore without its existing code
  breaking.
- **Major.** Removing or narrowing anything a plugin can call: a required field gets a
  stricter type, a builder's signature narrows, or a builder is removed. Changing what an
  existing `Action` kind means once the kit applies it, so a plugin emitting the same action
  as before now gets a different result on the target repo. Tightening a payload invariant
  (below), since an already-published plugin's payload could violate the new rule.
- **Patch.** A fix that keeps every documented contract as it was.

The payload invariants are part of the contract, not an implementation detail. A plugin's
payload scripts must have zero npm dependencies and must run on bare node, and a hook script
must exit 0 on every failure path rather than crash a turn. `payload/__test__/dependencies.test.ts`
and `payload/__test__/execution.test.ts` enforce both against the kit's own payload the same
way a plugin's would be held to them.

`.claude/scripts/lib/*.mjs` is a public runtime API too, versioned with `@agent-kit/payload`,
the package that ships those libs, because plugin payload scripts import them instead of
vendoring copies (see the decision "The CLI package ships substrate that plugins build on",
which `node .claude/scripts/decision-log.mjs list` will find). A signature change to a lib
function follows this same minor/major split.

## 12. How a plugin's payload reaches a shared lib

The six shared libs (`backlog-id`, `entry-ledger`, `kit-config`, `ledger-index`, `proc`,
`workspaces`) ship from `@agent-kit/payload`, not from the CLI. Import one by package name,
for values as well as types:

```ts
import { repoRoot } from '@agent-kit/payload/kit-config';
import type { LedgerEntry } from '@agent-kit/payload/ledger-index';
```

Add `@agent-kit/payload` to `peerDependencies`, not `dependencies`, alongside `@agent-kit/api`
(§11), only if a payload script imports a shared lib. Then run `agent-kit-payload` after your
`tsc`, which is a bin `@agent-kit/cli` publishes:

```json
"build": "tsc -p tsconfig.build.json && tsc -p tsconfig.payload.json && agent-kit-payload && publint"
```

It takes your payload root, defaulting to `payload-dist`, and does two things. It rewrites every
`@agent-kit/payload/*` specifier in your emitted `.mjs` to the relative path the installed
layout needs, since everything flattens into one `.claude/scripts/lib/` directory in the target
repo. And it writes `payload-dist/payload-imports.json` recording which libs each emitted file
imports, which the installer reads to copy those libs from `@agent-kit/payload`'s own payload
build. You declare no lib copies yourself, and you cannot forget one.

Three things worth knowing:

- **A type import costs nothing.** It erases before emit, so it never reaches the `.mjs` and no lib
  is copied for it. Keep `import type` as `import type`.
- **A misspelled lib fails your build**, naming the file and the lib, rather than shipping a script
  that dies with `ERR_MODULE_NOT_FOUND` in someone's repo.
- **Never hand-write the rewritten form.** Import by package name and let the tool do it. A bare
  `@agent-kit/*` specifier surviving into an emitted `.mjs` would try to resolve from
  `.claude/scripts/` in a user's repo on every hook, which is why the CLI's own test suite fails on
  one.

Your own libs are a different case. A payload file importing a lib from its OWN package uses an
ordinary relative path, and nothing rewrites it.

**A lib is passed its inputs, never reaches for config itself.** `readGateInputs(ledgerDirectory,
autoSync)` is the pattern: the payload script is the composition root, and a pure lib takes what it
needs as parameters rather than loading `kit.config.json` on its own. Write your own libs the same
way, so they stay testable without a filesystem.

**What your `package.json` and tsconfig split need, for an author outside this workspace:**

- `peerDependencies: { "@agent-kit/api": ">=0.0.0 <1.0.0" }`, pinned to the range of the
  `PluginApi` surface you built against (§11). This is what lets the resolver reject an
  incompatible version at install time instead of failing inside your script.
- A `peerDependencies` entry on `@agent-kit/payload`, not `dependencies`, if any of your payload
  scripts import a shared lib. `agent-kit-payload` resolves that package by name to rewrite the
  specifier and to copy the libs your build declares. A plugin with no payload scripts, or one
  that imports no shared lib, does not need this entry.
- `payload-dist` listed in `package.json`'s `files`, alongside `dist`. Without it, `npm publish`
  ships your compiled `dist/` but not the payload the installer copies into a user's repo.
- The three-tsconfig split, one job each, same as the CLI's own (see the top-level Layout section
  of this repo's `CLAUDE.md` for the general pattern):
  - `tsconfig.build.json` emits your TypeScript source. `rootDir: "./src"`, `outDir: "./dist"`,
    excluding your tests.
  - `tsconfig.json` typechecks everything, `src/` and tests alike. It `extends` the build config,
    sets `noEmit: true` and `rootDir: "."`, and clears the inherited test exclude.
  - `tsconfig.payload.json` compiles your `.mts` payload scripts. `rootDir: "./payload"`,
    `outDir: "./payload-dist"`. This one is only needed if you ship `.mts` scripts at all: a
    prose-only plugin (rules, skills, agents, reference docs) has no compile step and needs no
    payload tsconfig.
- `agent-kit-payload` runs after both `tsc` invocations, not before either: `tsc -p
tsconfig.build.json && tsc -p tsconfig.payload.json && agent-kit-payload`. It rewrites the
  `.mjs` your payload `tsc` just emitted, so running it first would find nothing to rewrite.
- The payload invariants from §11 apply to every script you ship this way: zero npm dependencies,
  node builtins only, and a hook script exits 0 on every failure path rather than crashing a turn.
  A script that imports a CLI lib does not relax this. The lib itself is bound by the same rule,
  which is why it is safe to import.
