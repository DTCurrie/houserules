# Spike: what would a second agent harness cost?

Research spike. No behavior changed. Every repo claim below cites a file and symbol you can
grep for yourself. Every claim about another harness cites the URL it came from, fetched
2026-08-03. Where a claim could not be verified, it is marked unverified.

## Verdict

Defer. Do not build it now, and do not build a `harness` config field speculatively.

The parts of the kit that are prose (skills, rules, `AGENTS.md`-shaped instructions) already
travel to at least one other harness with zero kit changes, because Cursor reads
`.claude/skills/` directly (`https://cursor.com/docs/skills`, "Skill directories"). That is
the cheap 80% of the value, and it costs nothing because it rides on an emerging open standard
this kit did not have to adopt. The expensive 20% (hooks, the Bash guard, settings merging,
statusline, the whole `merge-settings.ts` surface) does not travel, and no harness examined
here shares Claude Code's `.claude/settings.json` shape closely enough for a path-and-format
profile to bridge it. That part is a second implementation, not a mapping, and 7 of 15 core
modules depend on it (see Module classification below). Building a `harness` abstraction now
would be shaping a seam for a shape no other harness actually has yet.

## Coupling inventory in this repo

Counted with `grep -rn ".claude/" packages/cli/src --include="*.ts" | grep -v __test__` from
`/Users/devin/Projects/claude-kit`.

- **124** occurrences of the literal `.claude/` across 34 non-test files in `packages/cli/src`
  (`grep -rln "\.claude/" src --include="*.ts" | grep -v __test__ | wc -l` for the file count,
  `grep -rn` for the occurrence count).
- **10** files reference `CLAUDE.md` by name: `src/detect.ts`, `src/render.ts`, `src/ui.ts`,
  `src/plan.ts`, `src/core/config.ts`, `src/commands/doctor/resident-surface.ts`,
  `src/modules/plans.ts`, `src/modules/sweep.ts`, `src/modules/core.ts`,
  `src/modules/debug-session.ts`.
- The **seven payload builders** in `src/modules/copy-actions.ts` (`createPayloadBuilders`,
  called at module load as `kitBuilders`) hardcode every destination:
  `script` → `.claude/scripts/${name}`, `lib` → `.claude/scripts/lib/${name}`, `skill` →
  `.claude/skills/${name}/SKILL.md`, `agent` → `.claude/agents/${name}.md`, `rule` →
  `.claude/rules/${name}.md`, `reference` → `.claude/reference/${name}.md`, `template` →
  `.claude/kit-templates/${rel}`. The eighth builder, `file`, is an escape hatch that takes an
  arbitrary `dest` string, used by `src/modules/prettier-guard.ts` for `.prettierignore`
  (a repo-root file, not under `.claude/`).
- `SHARED_HOST_FILES` in `src/plan.ts` (line 149) names four host-owned paths:
  `.claude/settings.json`, `CLAUDE.md`, `.gitignore`, `.prettierignore`. Two of the four are
  Claude-Code-specific paths; two are not.
- `src/modules/hook-wiring.ts` is the most harness-specific file in the tree. `hookCommand`
  (line 20) hardcodes the shell guard `[ -f "$CLAUDE_PROJECT_DIR/.claude/scripts/${scriptName}" ]`,
  which depends on the `CLAUDE_PROJECT_DIR` environment variable Claude Code injects into hook
  processes. `hookFragment` (line 26) shapes a `SettingsFragment` keyed by Claude Code's hook
  event names (`PreToolUse`, `PostToolUse`, `SessionStart`, `UserPromptSubmit`, `Stop`, etc, as
  consumed via `src/merge-settings.ts`'s `HookEntry`/`HookGroup`). `scriptPermission` (line 40)
  emits a Claude Code permission-rule string, `Bash(node .claude/scripts/${scriptName}:*)`.
- `src/merge-settings.ts` defines `Settings`, `SettingsFragment`, `HookEntry`, `HookGroup`,
  `Permissions` (lines 1-34): this is a structural copy of the `.claude/settings.json` schema,
  including the `permissions.allow/deny/ask` shape and the `hooks: Record<event, HookGroup[]>`
  shape. Nothing in this file is generic; every field name matches Claude Code's own settings
  file.
- `src/render.ts` (446 lines) generates the CLAUDE.md managed region: `renderClaudeMd`,
  `renderClaudeAdditions`, `renderKitConfig`. Its content (function names, section headers)
  targets the file Claude Code loads as memory. Porting it to `AGENTS.md` is mostly a rename,
  since the two files serve the same purpose (see below), but the region-marker mechanism in
  `src/core/regions.ts` and the `RegionAction`/`BodyAction` split in `src/actions.ts` (both
  filesystem-path-agnostic) would carry over unchanged.
- `src/core/manifest.ts`'s `KitManifest` records dest paths verbatim, so a manifest built
  against `.claude/*` cannot be read against `.codex/*` or `.cursor/*` without a migration path
  of its own.

## Module classification

All 15 modules in `MODULES` (`src/plan.ts` line 124). Classified by whether the module's value
survives a harness swap without kit-side reimplementation.

**(a) Portable as-is — the value is prose or a plain script, no Claude-Code-only mechanism**

- `rename` (`src/modules/rename.ts`): ships a script only (`script(id, ...)`, line 27), no
  hook, no skill. A plain CLI script that runs the same anywhere `node` runs.
- `reviewers` (`src/modules/reviewers.ts`): ships a skill (line 29) plus an `advise` line. The
  skill body is portable per the Agent Skills finding below; nothing else in the module is
  harness-specific.
- `plans`, `orchestrate`, `verify-changed` (partially), `ready`, `sweep`, `code-cleanliness`:
  each ships a `skill(...)` and/or `agent(...)` and an `advise` line, no `hookFragment` call.
  `code-cleanliness` additionally ships a `rule(...)` (body-split file) and a `reference(...)`
  doc. All of these are static Markdown the module hands to `copy-actions.ts`; the content, not
  a Claude-Code mechanism, is the product.

**(b) Portable only if the target harness has an equivalent mechanism**

- `core` (`src/modules/core.ts`): ships libs, the Bash guard script, and two `hookFragment`
  calls (`PreToolUse`/`Bash` at line 187, `UserPromptSubmit` at line 194). Depends on hooks
  existing at all, and on the target's hook events lining up with `PreToolUse`/
  `UserPromptSubmit`. Also always writes the `CLAUDE.md` region (`renderClaudeMd`), which
  needs an equivalent memory file, not necessarily the same filename.
- `lint-fix`, `session-context`, `debug-session`, `read-guard`, `regen`: each calls
  `hookFragment` exactly once (verified by grep above) to wire a `SessionStart`, `PreToolUse`,
  or similar event. Useless without a hook mechanism on the target, and even with one, the
  event taxonomy has to line up (see the Codex finding below, where it happens to).

**(c) Meaningless outside Claude Code**

- `statusline` (`src/modules/statusline.ts`): configures Claude Code's `statusLine` settings
  key, a UI element specific to the Claude Code terminal UI. No evidence any of the four
  surveyed harnesses has an equivalent status line hook a script can drive (Cursor has a
  `/statusline` skill for its own CLI status line, a different, product-specific surface, per
  `https://cursor.com/docs/skills`).

Count: 6 modules in (a), 6 in (b) counting `core` once, 1 in (c). `verify-changed` ships a
script (line 33) and a skill (line 38) but no hook fragment, so it is closer to (a) with an
asterisk: it depends on the changeset-check script being runnable, which is harness-agnostic,
but its `advise` copy still assumes Claude Code's language for describing hooks.

## What other harnesses actually expect

Fetched directly, not from training memory.

**Cursor.** Rules live in `.cursor/rules/*.mdc`, frontmatter `description`/`globs`/
`alwaysApply` (`https://cursor.com/docs/context/rules`, "Project rules live in `.cursor/rules`
as `.mdc` files"). Plain `.md` in that directory is ignored, "use AGENTS.md instead" for the
simple case. Skills load from `.agents/skills/`, `.cursor/skills/`, and **also from
`.claude/skills/` and `.codex/skills/` "for compatibility"**
(`https://cursor.com/docs/skills`, "Skill directories"). Hooks exist: `hooks.json` at project
or user level, JSON-over-stdio, event names `sessionStart`/`preToolUse`/`postToolUse`/
`subagentStart`/`subagentStop`/`stop` etc (`https://cursor.com/docs/hooks`, "Hook
categories"), camelCase rather than Claude Code's PascalCase but semantically close. Subagents
exist as a first-class concept with a foreground/background split
(`https://cursor.com/docs/subagents`).

**OpenAI Codex CLI.** Reads `AGENTS.md`/`AGENTS.override.md` at `~/.codex` (global) and walked
down the project tree, concatenated root-to-leaf, capped at 32 KiB
(`https://developers.openai.com/codex/agent-configuration/agents-md`). Config directory is
`~/.codex` or `<repo>/.codex`. Hooks exist via `hooks.json` or `[hooks]` in `config.toml`, and
the event names are close to identical to Claude Code's: `PreToolUse`, `PostToolUse`,
`SessionStart`, `SessionEnd`, `UserPromptSubmit`, `Stop`, `SubagentStart`, `SubagentStop`,
`PreCompact`/`PostCompact` (`https://developers.openai.com/codex/hooks`, "Hooks run at
different points in a conversation"). This is the closest match to Claude Code's hook
taxonomy of anything surveyed. Skills are supported and explicitly said to "build on the open
agent skills standard" (`https://developers.openai.com/codex/skills`, citing
`https://agentskills.io/`).

**GitHub Copilot.** Three separate instruction mechanisms, not one:
`.github/copilot-instructions.md` (repo-wide), `.github/instructions/NAME.instructions.md`
with an `applyTo` glob in frontmatter (path-specific), and `AGENTS.md` anywhere in the repo,
nearest-file-wins (agent instructions)
(`https://docs.github.com/en/copilot/how-tos/configure-custom-instructions/add-repository-instructions`,
"Creating custom instructions"). No hooks, no subagents, no skills mechanism documented on
that page. Copilot is the most instruction-only of the four.

**Aider.** No dedicated config directory. `CONVENTIONS.md` (or any name) loaded with
`--read` or `/read`, and can be pinned in `.aider.conf.yml` via `read: CONVENTIONS.md`
(`https://aider.chat/docs/usage/conventions.html`). No hooks, no skills, no subagents
mechanism in the docs.

**Windsurf (now under the "Devin Desktop"/Cognition brand at docs.windsurf.com, unverified
whether this rebrand is complete or in transition).** Rules in `.devin/rules/*.md` (preferred)
or `.windsurf/rules/*.md` (fallback), frontmatter `trigger` with values `always_on`, `glob`,
`model_decision`, `manual` (`https://docs.windsurf.com/windsurf/cascade/memories`, "Activation
Modes"). Also reads `AGENTS.md` at any directory depth through the same rules engine, root
level always-on. "Skills" and "Workflows" exist as separate concepts from Rules, workflows
being manual slash-command prompt templates. No hook mechanism is mentioned on this page.

**Cross-harness summary table**

| Harness                | Instruction file                               | Config dir                | Hooks                           | Subagents                                                           | Skills                           |
| ---------------------- | ---------------------------------------------- | ------------------------- | ------------------------------- | ------------------------------------------------------------------- | -------------------------------- |
| Claude Code            | `CLAUDE.md`                                    | `.claude/`                | Yes, PascalCase events          | Yes                                                                 | Yes, `SKILL.md`                  |
| Cursor                 | `AGENTS.md` or `.cursor/rules/*.mdc`           | `.cursor/`                | Yes, camelCase events           | Yes                                                                 | Yes, reads `.claude/skills/` too |
| Codex CLI              | `AGENTS.md`                                    | `.codex/`                 | Yes, near-identical event names | Yes                                                                 | Yes, open standard               |
| Copilot                | `.github/copilot-instructions.md`, `AGENTS.md` | `.github/`                | Not documented                  | Not documented                                                      | Not documented                   |
| Aider                  | `CONVENTIONS.md` (any name)                    | none                      | No                              | No                                                                  | No                               |
| Windsurf/Devin Desktop | `AGENTS.md` or `.devin/rules/*.md`             | `.devin/` or `.windsurf/` | Not documented                  | Not documented (Workflows are prompt templates, not the same thing) | Yes, separate from Rules         |

## The seam: is a `harness` config field enough

No, not as a single mapping. Two different problems hide inside "target a second harness,"
and they do not have the same shape.

**Path and filename substitution is genuinely a mapping.** `.claude/` → `.codex/` or
`.cursor/`, `CLAUDE.md` → `AGENTS.md`. This part really is small: the 124 `.claude/` literals
all funnel through the seven builders in `copy-actions.ts` plus the one `file()` escape hatch,
and `PayloadBuilders` is already an interface a caller binds to a root
(`createPayloadBuilders(payloadRoot)`), so adding a second parameter for the base directory
and file names is a contained change to one file plus `SHARED_HOST_FILES`.

**Hook semantics are not a mapping, they are a second implementation per harness.** Claude
Code's `hookCommand` embeds `$CLAUDE_PROJECT_DIR`, a Claude-Code-only environment variable
with no analog confirmed on any other harness surveyed. `scriptPermission` emits a
`Bash(node ...)` permission-rule string in Claude Code's own permission-rule grammar, which
none of the four other harnesses share (Copilot and Aider have no permission-rule concept at
all; Cursor and Codex have different config files entirely, `hooks.json` vs
`.claude/settings.json`, with different merge semantics `src/merge-settings.ts` was written
for). Even where the event names are close (Codex: `PreToolUse`, `PostToolUse`,
`SessionStart`, `Stop`, `SubagentStop`, near-identical to Claude Code), the settings file
shape, matcher syntax, and trust model differ enough that `mergeSettings`/`renderSettings`
in `src/merge-settings.ts` would need a Codex-specific sibling, not a parameterization of the
existing one. That is 339 lines rewritten per harness that has hooks at all, times the harness
count, not once.

**Skills already need no seam for at least one harness.** Cursor reads `.claude/skills/`
directly. This is dumb luck (the kit's directory choice happens to be one of Cursor's four
search paths), not a design property this codebase built, so it is not evidence a
`harness` field is nearly done. It is evidence that shipping SKILL.md content well is
worth more than plumbing paths.

So the honest seam is two changes of very different size: a real, small mapping for paths and
prose destinations, and a from-scratch settings/hooks module per harness that has hooks (2 of
5 surveyed do, closely enough to be worth doing: Cursor and Codex). Copilot, Aider, and
Windsurf have no hook mechanism at all, so `core`, `lint-fix`, `session-context`,
`debug-session`, `read-guard`, `regen`, and `statusline` (7 of 15 modules) would ship nothing
functional on those three, only whatever prose survives as an `AGENTS.md`/rules fragment.

## Cost estimate

- **Path/prose mapping** (extend `PayloadBuilders`, parameterize `SHARED_HOST_FILES`, rename
  the `CLAUDE.md` render target): small, on the order of the existing `copy-actions.ts` (158
  lines) plus test coverage. Genuinely a config-and-mapping problem.
- **One hooks/settings backend per harness that has hooks** (Cursor, Codex): each is a new
  module comparable in size to `merge-settings.ts` (339 lines) plus `hook-wiring.ts` (42
  lines) plus the doctor checks that read settings.json today
  (`src/commands/doctor/settings-wiring.ts`, `src/commands/doctor/install-integrity.ts`, both
  in the 33-file `.claude/`-coupled list above), rewritten against that harness's config
  format and trust model, not shared with Claude Code's.
- **Detection** (`src/detect.ts`, 430 lines, defines `Ctx`/`Target`): would need to detect
  which harness(es) a repo targets, likely from which config directory already exists, adding
  branching to a file that currently assumes exactly one target.
- **What stays broken regardless of effort**: Copilot, Aider, and Windsurf have no hook
  mechanism, so the Bash guard (`core`'s single highest-value feature, per its module title
  "Core (config, Bash guard, permissions, CLAUDE.md seed)") and the other 6 hook-dependent
  modules would ship as no-ops or as unenforced advice on those three harnesses. `statusline`
  never has anywhere to go outside Claude Code.
- Realistic size for "Cursor support, hooks included": several weeks, not days, once the
  settings backend, detection, and doctor/update paths are all accounted for, not just the
  seven builders. This is a size estimate from the counts above, not a stopwatch measurement.

## What would change the answer

- **A second harness adopting a hook mechanism with an event taxonomy and trust model close
  enough to Claude Code's that `merge-settings.ts` could be parameterized instead of
  reimplemented.** Codex is the closest today (`PreToolUse`/`PostToolUse`/`SessionStart`/
  `Stop`/`SubagentStop` all match Claude Code's names per
  `https://developers.openai.com/codex/hooks`), so a concrete migration attempt against Codex
  specifically, not a fourth abstraction layer, is the fastest way to learn whether that
  convergence is real or coincidental naming.
- **User demand.** Nothing in this repo's issue tracker or `BACKLOG.md` was reviewed for this
  spike; if real users are asking for Cursor or Codex support, that is a different signal than
  architectural convenience and should be weighed independently.
- **The Agent Skills standard (`agentskills.io`) gaining hook or subagent equivalents**, which
  would turn today's lucky path overlap into an actual portable contract instead of one
  harness's directory choice matching another's by coincidence.
