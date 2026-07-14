# Backlog — repo root

Deferred work. Add entries via `.claude/scripts/backlog-log.mjs`; remove on resolution.

## [CLAUDEKIT-564f18] Hypothesis-driven debugger skill/agent with structured trace-log loop and instrumentation cleanup

**Logged:** 2026-07-14
**Chat:** c7c5a67e-0d18-4b8f-8196-111838e7d6c9

Source: user request (2026-07-14). A skill/agent for systematic debugging.

Flow: accept a bug-description prompt -> form explicit hypotheses -> add trace/debug
logging to the code to test each hypothesis -> emit that logging to a structured,
.gitignored log file under `.claude/debug/` (e.g. JSONL) -> read it efficiently with
`jq` -> confirm/reject/support each hypothesis from the output -> loop until a root
cause is found or all hypotheses are resolved -> review findings with the user ->
propose a suggested fix -> and, once the user confirms the issue resolved (or on
request), remove ALL added instrumentation so nothing is orphaned in source.

Grounded in radium-sunrise/.claude/debug/ discipline (radium CLAUDE.md "Debugging with
end-to-end tracing"). Kit-fit: payload/skills/debug-session/SKILL.md (zero-dep) plus an
optional agent template; `.claude/debug/` self-gitignores like `.claude/tool-output/`;
track every instrumentation edit so cleanup is complete. Consider a cleanup-guard hook.
Note: the ultracode investigation surfaced a lighter version and observed the _discipline_
already ships as a CLAUDE.md-template section — this is the fuller interactive skill/agent
the user actually wants, so build the loop + log format + cleanup tracking, not just prose.

---

## [CLAUDEKIT-23d373] Phased-implementation planning skill/agent (PLAN + ROADMAP + per-phase sub-plans in .claude/plans/<name>/)

**Logged:** 2026-07-14
**Chat:** c7c5a67e-0d18-4b8f-8196-111838e7d6c9

Source: user request (2026-07-14). SUPERSEDES/expands the investigation "plans module"
candidate (Tier 2 #13) — do not create a separate #13 entry.

A planning skill/agent that uses the existing planning tools, but when an implementation
is large / multi-step / multi-phase, commits the plan to a .gitignored
`.claude/plans/<plan-name>/` directory containing:

- `PLAN.md` — core doc: general overview + links out to the roadmap and to each sub-plan.
- `ROADMAP.md` — a LIVING status doc tracking completed / in-progress / future work.
- one sub-plan doc per phase of work.
  The agent manages the implementation as a project: it updates ROADMAP.md (and the relevant
  sub-plan) as each phase/step is completed. Resume discipline: a returning session greps
  ROADMAP status instead of re-deriving scope from the transcript.

Grounded in radium-sunrise/.claude/plans/*.plan.md (dated, Status-tracked, cross-referencing
plan artifacts). Kit-fit: an opt-in `plans` module (defaultEnabled false) shipping a `/plan`
SKILL.md (zero-dep markdown) that scaffolds the `.claude/plans/<name>/` dir + a module-gated
root-CLAUDE.md planning pointer. Keep the plans dir PULL-ONLY via the root CLAUDE.md pointer
(a nested `.claude/plans/CLAUDE.md` won't load when it's needed). Investigation flagged: drop
any invented INDEX/plan-log script; the value is the doc structure + status-in-place discipline.

---

## [CLAUDEKIT-217f59] verify-changed skill + script: DAG-scoped lint/check/test on changed packages plus dependents

**Logged:** 2026-07-14
**Chat:** c7c5a67e-0d18-4b8f-8196-111838e7d6c9

[investigation: STRONG | value high | effort M | agent-efficiency]

Diff against the changesets baseBranch, map changed paths -> packages (reuse
lint-format-fix.mjs:58-108 prefix map), walk workspace dependency edges (lib/workspaces.mjs:85
exposes pkg.dependencies) to add transitive DEPENDENTS, and run check/test/lint on only that
set INSIDE a subagent so a compact PASS/FAIL-per-package verdict returns instead of a
multi-minute full-suite transcript (radium's sweep is ~4 min, CLAUDE.md:100). Removes the
hand-maintained "shared packages" list (radium CLAUDE.md:26). Named near-verbatim in
CONVENTIONS §8 (lines 132-134). Reuse changeset-check.mjs:71-95 for the base...HEAD +
working-tree baseline. Net-new: reverse-dependency traversal, detectVerifyCommands in
detect.mjs (config today has only fix.commands), a verify config block + doctor validation,
cli/modules/verify-changed.mjs, payload/skills/verify-changed/SKILL.md. Load-bearing: the
skill MUST spawn a subagent and return only the per-package verdict (allowed-tools: Agent),
or the off-context benefit is lost. Degrade to full-scope/exit-0 on any git/config failure.

---

## [CLAUDEKIT-743924] /sweep skill: shard wide mechanical edits into package-boundaried haiku writers

**Logged:** 2026-07-14
**Chat:** c7c5a67e-0d18-4b8f-8196-111838e7d6c9

[investigation: STRONG | value high | effort S | agent-efficiency]

On-demand /sweep SKILL.md that turns a repo-wide mechanical edit into: locate-once ->
shard-by-package -> fan out one haiku / effort:low writer per shard (each reporting only a
one-line count) -> verify affected packages. The orchestrator pays O(shards) not O(hits) and
never sees the match set or individual diffs. Fills the CONVENTIONS §8 gap that the kit's own
generated CLAUDE.md already instructs agents to do. Zero-dep markdown skill copied via a
module through apply.mjs. Consider a pinned read-only writer agent to bound the fan-out.

---

## [CLAUDEKIT-320464] /review-change skill: dispatch per-target reviewers by changed path, bundled with the reviewers module

**Logged:** 2026-07-14
**Chat:** c7c5a67e-0d18-4b8f-8196-111838e7d6c9

[investigation: STRONG | value high | effort S | engineer-productivity]

Zero-dep /review-change SKILL.md (emitted by the reviewers module) that maps
`git diff --name-only` to each target's ${name}-reviewer via the existing pathPrefix
convention, fans them out in ONE message as read-only Agent calls, and reconciles
OK/Conflict/Gap verdicts. Moves radium's ~8-line always-loaded fan-out recipe + path->reviewer
table onto disk, and finally DISPATCHES the reviewer drafts the kit already ships but never
wires up. Bundle the skill copy into cli/modules/reviewers.mjs.

---

## [CLAUDEKIT-d1284a] doctor: measure and WARN on the always-loaded context surface against the token/line budget

**Logged:** 2026-07-14
**Chat:** c7c5a67e-0d18-4b8f-8196-111838e7d6c9

[investigation: STRONG | value high | effort S | context-economics]

Read-only doctor readout that estimates tokens (chars/4) and counts lines of the RESIDENT
surface — root CLAUDE.md plus any resolved @-imports (optionally the machine-local MEMORY.md
index) — printing headroom vs the ~3-4K-token / ~200-line budget (CONVENTIONS §1) and WARNing
past it. List nested package CLAUDE.mds SEPARATELY (on-demand tier, never summed into the
resident total). Makes the kit's #1 lever measurable; today it is only prose discipline.

---

## [CLAUDEKIT-1df1b2] Persona-auditor agent template (blind-rank-then-reconcile) plus optional /persona-audit fan-out skill

**Logged:** 2026-07-14
**Chat:** c7c5a67e-0d18-4b8f-8196-111838e7d6c9

[investigation: STRONG | value high | effort M | agent-efficiency]

Package radium's radium-player-*.agent.md pattern: a read-only, haiku, single-JSON-output
persona-auditor TEMPLATE that blind-ranks a component's options from stated priorities BEFORE
reconciling against what the system actually chose, bucketing divergences with a typed cause
enum. Anti-anchoring discipline ("do not read the engine's scoring code") is the non-obvious
IP. Ship default-off as a reference template alongside reviewer/archivist via the existing
template() helper (cli/modules/shared.mjs:47) into gitignored .claude/kit-templates/agents/,
wired by an opt-in module mirroring ledger.mjs; read-only tools satisfy §4, haiku satisfies
§3. Ship the template FIRST (strong); the /persona-audit fan-out skill is a follow-up whose
decision-stream input contract must be placeheld (bespoke per repo, cannot be shipped).

---

## [CLAUDEKIT-5ee4cc] init preflight: refuse or re-root installs below the git toplevel

**Logged:** 2026-07-14
**Chat:** c7c5a67e-0d18-4b8f-8196-111838e7d6c9

[investigation: STRONG | value medium | effort S | robustness]

init roots at resolve(dir) and only checks isRepo, so installing from a monorepo SUBDIR
writes .claude/ where the payload's git-toplevel-resolving hooks (repoRoot() everywhere) will
never find the config — a silently broken install. Add a preflight: when
resolve(root) !== ctx.git.top, hard-error with the exact `cd <toplevel>` fix (or prompt to
re-root). Add a nested-dir fixture test.

---

## [CLAUDEKIT-8192cd] doctor: warn on workspace packages that have no kit target

**Logged:** 2026-07-14
**Chat:** c7c5a67e-0d18-4b8f-8196-111838e7d6c9

[investigation: STRONG | value medium | effort S | robustness]

The inverse of doctor's existing target->workspace check: loop the already-imported
listWorkspacePackages and WARN (exit 0) for each member whose name matches no
config.targets[].packageName, pointing the user to hand-edit kit.config.json (NOT "re-run
init", which skips the existing seed). A package added after init otherwise silently misses
lint-fix / reviewer / ledger coverage while doctor still reports "healthy".

---

## [CLAUDEKIT-97b39e] Opt-in PreToolUse(Read) guard: redirect unbounded whole-file reads of oversized/generated files

**Logged:** 2026-07-14
**Chat:** c7c5a67e-0d18-4b8f-8196-111838e7d6c9

[investigation: CONSIDER | value high | effort M | context-economics]

Opt-in payload/scripts/guard-read.mjs wired PreToolUse(Read), mirroring guard-bash.mjs, that
exit-2 redirects ONLY unbounded whole-file reads of: oversized files (maxBytes), lockfiles /
dist / _.min._, and kit "GENERATED — do not edit" snapshots. Reads already carrying
offset/limit PASS (targeted reads are fine). Enforces the already-MARKETED but currently
unenforced "grep don't read whole" rule (README:88, CONVENTIONS §7 line 120). READ_GUARD_DEFAULTS
in lib/kit-config.mjs (like GUARD_DEFAULTS); new opt-in module. VERIFY FIRST on the stock CLI
that PreToolUse matcher "Read" + exit 2 actually blocks a Read (kit's updatedToolOutput scar).
The GENERATED-header trigger is latent until the §7 snapshot generator ships — scope v1 to
denyGlobs + maxBytes, which pay off immediately.

---

## [CLAUDEKIT-9d309f] doctor + update: detect and prune retired kit modules/hooks/files (kill the live inert tool-output compactor)

**Logged:** 2026-07-14
**Chat:** c7c5a67e-0d18-4b8f-8196-111838e7d6c9

[investigation: CONSIDER | value medium | effort M | robustness] Concrete deployed instance.

The kit is add/update-only — it can never REMOVE what it retires, so schoolyard-games still
runs the retired compact-tool-output.mjs as a PostToolUse(Bash) hook (fires a useless node
process on every Bash call; ~19 dead spill files; updatedToolOutput is inert per MEMORY).
Add: doctor WARNs for wired hook scripts + manifest modules the current kit no longer defines
(reverse of doctor.mjs HOOK_SCRIPTS 16-21); plus a declarative delete-file + remove-hook prune
in update/apply, guarded to kit-owned + hash-unmodified files, previewed in dry-run;
merge-settings.mjs gains its FIRST removal path (surgically drop one hook by basename without
reordering/clobbering user hooks). Do NOT auto-delete the non-manifest tool-output/*.txt spills
(not kit-owned — advise only). Splittable: doctor-WARN alone is an S first slice that upgrades
schoolyard's orphan from invisible to detected. Prefer generic manifest-diff prune (new plan's
file-set vs previousManifest.files) over a per-retirement registry. See also #20 (signatures).

---

## [CLAUDEKIT-8efaf3] Opt-in reference-regen module: PostToolUse(Edit|Write|MultiEdit) generated-snapshot regen hook

**Logged:** 2026-07-14
**Chat:** c7c5a67e-0d18-4b8f-8196-111838e7d6c9

[investigation: CONSIDER | value medium | effort S | agent-efficiency]

Default-OFF module + zero-dep payload/scripts/regen-on-edit.mjs wiring a
PostToolUse(Edit|Write|MultiEdit) hook that re-runs a USER-OWNED generator when an edited file
matches a targets[].regen {sourceGlob, command}, exiting 2 with a trimmed tail on failure — so
a fragmented-corpus reference snapshot stays fresh and grep-able instead of silently staling.
Packages CONVENTIONS §7 and the brittle inline PostToolUse hook radium-sunrise hand-rolls.
hookFragment() (shared.mjs) already emits arbitrary event+matcher hooks; module clones the
ledger/lint-fix shape. Keep generators fast + sourceGlob tight (runs on every matching edit).

---

## [CLAUDEKIT-d581ae] /blast-radius worked-example skill: fan out read-only subagents once, archive a dated grep-able impact map

**Logged:** 2026-07-14
**Chat:** c7c5a67e-0d18-4b8f-8196-111838e7d6c9

[investigation: CONSIDER | value medium | effort S | agent-efficiency]

Skill that fans out read-only Explore/Grep subagents over a change's consumers ONCE and writes
a dated, disclaimer-headed .claude/plans/ impact map (per-file symbol/consumer/risk list +
HIGH/MED/LOW completeness audit) so downstream sessions grep the artifact instead of re-running
the survey. Grounded in radium's reused 829-line engine_blast_radius_2026-06-07.md. Reusable
kernel = artifact shape + read-only fan-out + "cites may be stale" disclaimer + freshness cue
(date + commit SHA). Ceiling is medium: leverage lives in repo-tuned fan-out prompts, so ship
the shape/discipline, not repo-specific logic (avoid the §8 "half-built repo-specific" trap).
Build standalone (no plans module exists) or bundle with the phased-planning feature.

---

## [CLAUDEKIT-0ad172] Backlog-aware UserPromptSubmit hook: auto-inject the decoded entry when a prompt references a backlog ID

**Logged:** 2026-07-14
**Chat:** c7c5a67e-0d18-4b8f-8196-111838e7d6c9

[investigation: CONSIDER | value medium | effort S | engineer-productivity]

Wire the unused UserPromptSubmit event to a read-only hook that, when a prompt contains a real
PREFIX-6hex backlog ID, injects that entry's decoded log record via stdout — saving a
re-derivation round-trip. Reuses BACKLOG_ID (lib/backlog-id.mjs) + node:zlib. Ship part (a)
only; DROP the "changed-targets delta" (duplicates session-context, adds per-turn resident
cost). Gate injection on the ID actually existing in backlog.log (else inject nothing); prefer
the latest add/update body over the full event history. Fold into the existing backlog module
(inert without it). VERIFY the additionalContext/stdout injection form on the stock CLI first;
mirror session-context.mjs's plain console.log which the kit already relies on.

---

## [CLAUDEKIT-7685bf] doctor: report terse-style as ACTIVE/INACTIVE (exact Kit Terse outputStyle), not merely installed

**Logged:** 2026-07-14
**Chat:** c7c5a67e-0d18-4b8f-8196-111838e7d6c9

[investigation: CONSIDER | value medium | effort S | context-economics]

When terse-style is in the manifest, have doctor read project settings.json / settings.local.json
outputStyle and report: installed-but-INACTIVE, ACTIVE, or a slug that silently falls back to
Default — with the exact fix string ("Kit Terse", not the kit-terse filename slug). Replaces
today's unconditional install-time note with a stateful signal. The kit's own
scripts/dogfood-link.mjs:131 is mis-slugged "kit-terse", proving the trap is real.

---

## [CLAUDEKIT-e68b1f] update/doctor: advertise genuinely-new modules to existing installs (advertise, never auto-enable)

**Logged:** 2026-07-14
**Chat:** c7c5a67e-0d18-4b8f-8196-111838e7d6c9

[investigation: CONSIDER | value medium | effort S | engineer-productivity]

update pins to manifest.modules and doctor only WARNs on version skew, so a module shipped
AFTER install is never surfaced to existing repos (init unions new defaults, but update — the
path people actually use — does not). Add a non-destructive one-line advisory naming addable
modules plus the exact `npx claude-kit modules --modules=<ids>`. Advertise only; never
auto-enable (respects user-owned module selection).

---

## [CLAUDEKIT-715c23] claude-kit report: read-only transcript telemetry (cache_read-per-turn) to make context savings measurable

**Logged:** 2026-07-14
**Chat:** c7c5a67e-0d18-4b8f-8196-111838e7d6c9

[investigation: CONSIDER | value medium | effort S | context-economics]

Read-only `claude-kit report [repo]` that aggregates ~/.claude/projects/<encoded-cwd>/*.jsonl
usage (cache_read / cache_creation, in/out, tool_result, turns, model mix, isSidechain share)
into per-session and rolled-up tables, so adopters can watch the numbers move across init and
module toggles. MUST cost-weight cache_read (the cheap tier) and DROP any "proves the levers"
framing to avoid a misleading vanity metric — native /usage already covers the live view. Also
serves as the parser substrate for later sub-reports. (Note: the investigation dropped three
dependent sub-checks — MEMORY hygiene, grep-adherence meter, unused-MCP detector — as vanity
metrics; don't revive them on top of this.)

---

## [CLAUDEKIT-8c7e00] /ready: off-context pre-handoff roll-up (acceptance checklist + backlog-resolved check + one verdict)

**Logged:** 2026-07-14
**Chat:** c7c5a67e-0d18-4b8f-8196-111838e7d6c9

[investigation: CONSIDER | value medium | effort M | engineer-productivity]

Read-only /ready SKILL.md that runs off-context and rolls the deterministic pre-handoff checks
into ONE ready/not-ready verdict plus the CLAUDE.md-mandated acceptance checklist. Novel kernel
= checklist emission + "backlog item resolved but not removed" detection. SEQUENCE AFTER
verify-changed and /review-change land — two of its five steps presuppose those still-unbuilt
features, and two others double-cover the automatic Stop hooks. Descope accordingly.

---

## [CLAUDEKIT-dfdc87] lint-fix: skip Stop/SubagentStop hook wiring (emit a one-time advisory) when no target has a fix script

**Logged:** 2026-07-14
**Chat:** c7c5a67e-0d18-4b8f-8196-111838e7d6c9

[investigation: CONSIDER | value medium | effort S | robustness]

When lint-fix is explicitly selected (headless --modules=lint-fix, or overriding the "no fix
scripts" hint) in a repo where NO target has a detected fix command, plan() still wires both
hooks — which, since config.fix.commands is always seeded, then run nonexistent
lint:fix/format:fix and spill package-manager errors into the main context on every turn
boundary. Guard the wiring at plan time on answers.targets fixCommands (NOT the always-present
config.fix.commands) and emit an advisory instead. Companion doctor tweak to suppress the
resulting false "hook not wired" WARN.

---

## [CLAUDEKIT-a4ed02] Record kit-contributed settings signatures in the manifest to enable safe reconcile

**Logged:** 2026-07-14
**Chat:** c7c5a67e-0d18-4b8f-8196-111838e7d6c9

[investigation: CONSIDER | value medium | effort L | robustness]

Persist the hooks/permissions the kit contributes as a settings SIGNATURE in
kit-manifest.json at apply time, so update can replace renamed hooks, drop hooks whose script
no longer ships, and prune retired files — touching ONLY entries it recorded. Unblocks an
eventual `modules --remove` / uninstall. Must be preview-gated (dry-run renders removals) and
hash-guarded (never delete/drop a user-modified entry — WARN instead). This is the
heavyweight, GENERAL version of the doctor+update prune item; the two should be designed
together. Splittable: an S wedge (record signatures + doctor reads them, non-destructive)
immediately upgrades schoolyard's orphaned compactor from invisible to a detected WARN.

---

## [CLAUDEKIT-ecaff8] Per-changed-extension scoping for the Stop-hook fix commands (skip eslint on docs-only edits)

**Logged:** 2026-07-14
**Chat:** c7c5a67e-0d18-4b8f-8196-111838e7d6c9

[investigation: CONSIDER | value low | effort M | agent-efficiency]

Optional per-command extension gate so lint:fix is skipped when only non-JS files changed
(default = today's behavior). NARROW: only benefits repos with SEPARATE lint:fix + format:fix
(the common unified `fix` script can't be split), and saves blocking Stop-hook LATENCY, not
context tokens. DROP the paired "hash residue, emit see-above next turn" idea the original
proposal bundled — its "see above" dangles once prior output leaves context, and lint/prettier
output rarely hashes stably across turns. Keep ONLY the extension gate. Low priority.

---

## [CLAUDEKIT-d9c7ca] Kit-aware statusline (opt-in): pending changeset debt + targets-touched

**Logged:** 2026-07-14
**Chat:** c7c5a67e-0d18-4b8f-8196-111838e7d6c9

[investigation: CONSIDER | value low | effort M | engineer-productivity]

Opt-in, zero-dep payload/scripts/statusline.mjs surfacing only the two fields the native
/statusline can't: pending changeset count (readdir .changeset) and kit targets-touched;
reuse the status JSON's context_window.used_percentage / cost for the ambient bar. Wire it
ONLY when no statusLine already exists (never clobber the user's global) — which requires
teaching merge-settings a new single-value fragment shape. Low priority.

---
