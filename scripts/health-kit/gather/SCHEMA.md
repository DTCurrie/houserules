# Baseline schema

Fixed once, reused by every health pass. `parse-usage-report.mjs` writes one usage JSON file per
report document, given as its `<out.json>` argument, against the `usage` key list.
`agent-ledger.mjs` writes one ledger file per machine, given as `--out`, against the
`agent-ledger` key list. A pass's analysis scripts read these keys and no others.

A change to a key list is a new schema version, written here first, with the old version kept.

## How a script checks its output

Each script reads this file at run time and takes the fenced block whose info string is
`keys usage` or `keys agent-ledger`. A copy of `agent-ledger.mjs` run away from this directory
carries the same list embedded, and asserts the embedded copy matches this file when the file is
beside it.

Each non-blank line of a block is `<path> <type> <note>`, split on whitespace: the first token is
the path, the second the type, and the rest is the note. Neither a path nor a type holds a space.
The path grammar:

- `a.b` is key `b` of object `a`.
- `a[]` is every element of array `a`. `a[].b` is key `b` of each element.
- `a{}` is every value of a map `a` whose keys are data, not schema. The note names what the keys
  are. `a{}.b` is key `b` of each value.

Before writing, the script walks its output, builds the path of every key it emits, and exits
non-zero naming the first path not in the block. A path in the block that the output never emits
is allowed, because sections are optional by render.

Types: `string`, `number`, `boolean`, `object`, `array`, and `|null` when the value may be null.
`number` is an integer unless the note says percent. Token and byte counts are raw integers, with
no thousands separators.

## Shared definitions

- **Weighted input** is `input + 0.1 × cacheRead + 1.25 × (cacheWrite - cacheWrite1h) + 2 × cacheWrite1h`,
  where `cacheWrite1h` is the 1-hour part of `cacheWrite`, read from
  `usage.cache_creation.ephemeral_1h_input_tokens` and 0 when absent. It is computed and rounded
  exactly as `packages/cli/src/commands/report/token-usage.ts` does, so a ledger sum can equal a
  report's printed total.
- **Session id prefix** is the first 8 hex characters of the session's `.jsonl` file name.
- **Repo label** is the install's directory name under `~/Projects`, for example `dotcom`.

## usage

Version `usage@1`. One file per machine, one `projects[]` entry per `###` section of the source
document, in document order.

Three renders exist. `current` is the 0.12.x report. `0.4.1` has no `sessions: N, from` line, no
per-session `main`/`subagents` line or per-model line, a `dead skills` label in place of
`unused here`, and no resident context section. `empty` is a fence holding only
`No .jsonl transcripts in ...` or `No transcripts found (looked in ...)`, and every section below `sessionsStated` is null or empty.

The built-in check, which exits non-zero on a mismatch: per project, `sessions.length` equals
`sessionsStated`, equals the `Sessions` cell of that project's `summary[]` row, and the sum of
`sessions[].turns` equals `totals.turns` and the `Turns` cell. An `empty` project passes with 0
sessions and a null `totals` when its `summary[]` row reads 0 and 0.

```keys usage
schema                                       string        "usage@1"
source                                       string        the input document's file name, no directory
date                                         string        YYYY-MM-DD from the document's H1
machine                                      object|null   the `## Machine context` bullets, null when the section is absent
machine.claudeCode                           string|null   Claude Code bullet, verbatim
machine.node                                 string|null   Node bullet, verbatim
machine.os                                   string|null   OS bullet, verbatim
machine.cleanupPeriodDays                    string|null   cleanupPeriodDays bullet, verbatim
machine.disableAllHooks                      string|null   disableAllHooks bullet, verbatim ("unset" when unset)
machine.outputStyle                          string|null   outputStyle bullet, verbatim
machine.enabledPlugins                       string|null   Enabled plugins bullet, verbatim
machine.userSkills                           string|null   User skills bullet, verbatim
machine.userAgents                           string|null   User agents bullet, verbatim
machine.userClaudeMd                         string|null   User CLAUDE.md bullet, verbatim
machine.houseRulesOnPath                     string|null   houserules on PATH bullet, verbatim
summary[]                                    object        one per row of the document's Summary table
summary[].project                            string        Project cell
summary[].kitVersion                         string        Kit version cell
summary[].installedAt                        string        Installed at cell, YYYY-MM-DD
summary[].reportCli                          string        Report CLI cell, verbatim
summary[].sessions                           number        Sessions cell
summary[].turns                              number        Turns cell
summary[].modules                            number|null   Modules cell, null when the column is absent
projects[]                                   object        one per `###` project section
projects[].name                              string        the `###` heading text
projects[].render                            string        "current" | "empty" | the CLI version the project's Report produced by CLI bullet states, for a render with no range line | "unknown" when that bullet is absent or states no version
projects[].header                            object        the section's header bullets
projects[].header.path                       string|null   Path bullet, verbatim, backticks stripped
projects[].header.kitVersion                 string|null   Kit version bullet, the version only
projects[].header.installedAt                string|null   the ISO timestamp in the Kit version bullet's parentheses
projects[].header.reportCli                  string|null   Report produced by CLI bullet, verbatim
projects[].header.neededUpdate               string|null   Needed update bullet, verbatim. null when absent
projects[].header.installStyle               string|null   Install style bullet, verbatim
projects[].header.packages                   string|null   houserules packages bullet, verbatim
projects[].header.hooksCount                 number|null   the count in the Hooks wired label
projects[].header.hooks[]                    string        one entry per hook, "Event[matcher]→script" as printed
projects[].header.modulesCount               number|null   the count in the Modules label
projects[].header.modules[]                  string        one entry per module id, as printed
projects[].header.versionCaveat              string|null   Version caveat bullet, verbatim
projects[].sessionsStated                    number        from the "N session(s):" line, 0 for empty
projects[].range                             object|null   from "sessions: N, from A to B", null when absent
projects[].range.from                        string        YYYY-MM-DD
projects[].range.to                          string        YYYY-MM-DD
projects[].sessions[]                        object        one per session row
projects[].sessions[].id                     string        session id prefix
projects[].sessions[].turns                  number
projects[].sessions[].input                  number        the `in` field, fresh input tokens
projects[].sessions[].output                 number        the `out` field
projects[].sessions[].cacheRead              number
projects[].sessions[].cacheWrite             number
projects[].sessions[].tools                  number        tool uses
projects[].sessions[].weightedIn             number        the `weighted-in` field
projects[].sessions[].wall                   string|null   the `wall` field verbatim, null when absent
projects[].sessions[].main                   object|null   the main half of the split line, null when absent
projects[].sessions[].main.weightedIn        number
projects[].sessions[].main.output            number
projects[].sessions[].subagents              object|null   the subagents half of the split line
projects[].sessions[].subagents.weightedIn   number
projects[].sessions[].subagents.output       number
projects[].sessions[].models[]               object        one per entry of the per-model line, empty when absent
projects[].sessions[].models[].model         string        model id as printed, `<synthetic>` included
projects[].sessions[].models[].weightedIn    number
projects[].sessions[].models[].output        number
projects[].totals                            object|null   the `-- totals --` block, null for empty
projects[].totals.turns                      number
projects[].totals.input                      number        `fresh input`
projects[].totals.output                     number
projects[].totals.cacheRead                  number
projects[].totals.cacheWrite                 number
projects[].totals.toolResults                number        `tool_results`
projects[].totals.cacheReadSharePct          number        percent, the integer printed
projects[].totals.weightedIn                 number        `cost-weighted input-equivalent`
projects[].totals.models[]                   string        the `models:` list, in printed order
projects[].totals.sidechainPct               number|null   percent, from `sidechain turns:`
projects[].totals.placeholderRecords         number        from the placeholder-usage line, 0 when absent
projects[].totals.listPrice                  object|null   the `list price:` line, null when absent. Dollars, not integers
projects[].totals.listPrice.total            number        dollars
projects[].totals.listPrice.fresh            number        dollars
projects[].totals.listPrice.cacheRead        number        dollars
projects[].totals.listPrice.cacheWrite       number        dollars
projects[].totals.listPrice.output           number        dollars
projects[].totals.notPriced[]                object        one per model on the `not priced` line, empty when absent
projects[].totals.notPriced[].model          string        model id as printed, `<synthetic>` included
projects[].totals.notPriced[].weightedPct    number        percent of weighted input, the integer printed
projects[].hookHealth[]                      object        one per row of the hook health table
projects[].hookHealth[].hook                 string        hook column, verbatim
projects[].hookHealth[].fires                number
projects[].hookHealth[].nonZero              number
projects[].hookHealth[].crashes              number
projects[].hookHealth[].blocks               number
projects[].hookHealth[].p50ms                number
projects[].hookHealth[].p95ms                number
projects[].hookHealth[].maxms                number
projects[].bashCalls                         number|null   from "this corpus holds N Bash tool calls"
projects[].crashSignatures[]                 object        one per crash signature line
projects[].crashSignatures[].count           number
projects[].crashSignatures[].signature       string        verbatim
projects[].guard                             string|null   the guard efficacy body, lines joined by one space
projects[].skills                            object|null   the skills section, null when absent
projects[].skills.rows[]                     object        one per row of the skill table
projects[].skills.rows[].skill               string
projects[].skills.rows[].model               number        Skill tool invocations
projects[].skills.rows[].user                number        typed slash commands
projects[].skills.rows[].total               number
projects[].skills.toolsetActive              object|null   from "toolset-active sessions: A of T"
projects[].skills.toolsetActive.active       number
projects[].skills.toolsetActive.total        number
projects[].skills.unusedLabel                string|null   "unused here" | "dead skills", null when the line is absent
projects[].skills.unused[]                   string        skill names on that line
projects[].skills.outcomes[]                 object        one per outcome line
projects[].skills.outcomes[].skill           string        "changeset" | "backlog-add" | "decide", no slash
projects[].skills.outcomes[].fired           number
projects[].skills.outcomes[].matched         number        via the outcome record, or the ledger-add count
projects[].skills.outcomes[].matchedGit      number|null   via the 72h git window, changeset only
projects[].skills.outcomes[].recordEntries   number|null   changeset only
projects[].skills.outcomes[].filesAdded      number|null   changeset only
projects[].skills.outcomes[].ledgerAdds      number|null   backlog-add and decide only
projects[].friction                          object|null   the friction section, null when absent
projects[].friction.compaction               object
projects[].friction.compaction.count         number
projects[].friction.compaction.sessions[]    string        session id prefixes, empty when none listed
projects[].friction.toolResultBulk[]         object        one per row of the tool_result bulk table
projects[].friction.toolResultBulk[].tool    string
projects[].friction.toolResultBulk[].results number
projects[].friction.toolResultBulk[].bytes   number
projects[].friction.bashRetries              object
projects[].friction.bashRetries.runs         number
projects[].friction.bashRetries.repeatedCalls number
projects[].friction.bashRetries.top[]        object        one per listed retry line
projects[].friction.bashRetries.top[].session string       session id prefix
projects[].friction.bashRetries.top[].count  number        the xN value
projects[].friction.bashRetries.top[].command string       the redacted command name, verbatim
projects[].friction.denials                  object
projects[].friction.denials.rejected         number
projects[].friction.denials.interrupted      number
projects[].friction.denials.samples[]        object        one per listed denial line
projects[].friction.denials.samples[].tool   string
projects[].friction.denials.samples[].command string|null  the redacted command, null when the line names a tool only
projects[].artifactEpisodes                  object|null   the `-- artifact episodes --` block, null when absent
projects[].artifactEpisodes.none             boolean       true when the block reads "No Artifact calls were recorded."
projects[].artifactEpisodes.rows[]           object        one per row of the episode table
projects[].artifactEpisodes.rows[].session   string        session id prefix
projects[].artifactEpisodes.rows[].calls     number
projects[].artifactEpisodes.rows[].comments  number
projects[].artifactEpisodes.rows[].publishes number
projects[].artifactEpisodes.rows[].requests  number
projects[].artifactEpisodes.rows[].wall      string        the wall cell verbatim, for example "113.1 min"
projects[].artifactEpisodes.rows[].output    number
projects[].artifactEpisodes.rows[].weightedIn number       the `weighted-in` cell
projects[].artifactEpisodes.rows[].sharePct  number        percent, the share-of-session cell without the sign
projects[].artifactEpisodes.rows[].model     string
projects[].installHealth                     object|null   this project's entry under `## Install health`, null when absent
projects[].installHealth.cliSource           string        "local" | "temporary", the word before "CLI" on the entry's first line
projects[].installHealth.cliVersion          string        the CLI version `doctor` ran from
projects[].installHealth.exit                number        the doctor exit code
projects[].installHealth.lines[]             string        the fenced doctor output, blank lines dropped, verbatim
projects[].guardReasons[]                    object        this project's rows under `## Guard reasons`, empty when it lists none
projects[].guardReasons[].guard              string        guard column, for example "PreToolUse:Bash"
projects[].guardReasons[].reason             string        reason column, verbatim
projects[].guardReasons[].blocks             number
projects[].resident                          object|null   the resident context section, null when absent
projects[].resident.recorded                 number        from "recorded A of T session(s)"
projects[].resident.total                    number
projects[].resident.rows[]                   object        one per session row of the table
projects[].resident.rows[].session           string        session id prefix
projects[].resident.rows[].recorded          boolean       false on a "not recorded" row
projects[].resident.rows[].entrypoint        string|null
projects[].resident.rows[].system            number|null   bytes
projects[].resident.rows[].instructions      number|null   bytes
projects[].resident.rows[].skills            number|null   bytes
projects[].resident.rows[].agents            number|null   bytes
projects[].resident.rows[].style             number|null   bytes
projects[].resident.rows[].total             number|null   bytes
projects[].resident.rows[].tokens            number|null   the ~tokens column
projects[].resident.rows[].nestedLoads       number|null   the count before the parentheses
projects[].resident.rows[].nestedBytes       number|null   the bytes inside the parentheses
projects[].resident.medians[]                object        one per medians line
projects[].resident.medians[].scope          string        "all", or the entrypoint named in the line
projects[].resident.medians[].sessions       number|null   the session count in the line, null for "all"
projects[].resident.medians[].totalBytes     number
projects[].resident.medians[].tokens         number
projects[].resident.nested[]                 object        one per "nested loads, <session>:" block
projects[].resident.nested[].session         string        session id prefix
projects[].resident.nested[].loads           number
projects[].resident.nested[].bytes           number
projects[].resident.nested[].mainLoads       number
projects[].resident.nested[].mainBytes       number
projects[].resident.nested[].subagentLoads   number
projects[].resident.nested[].subagentBytes   number
projects[].resident.nested[].rules[]         object        one per rule-file line
projects[].resident.nested[].rules[].path    string        as printed: a rule under .claude/rules/ or a nested CLAUDE.md
projects[].resident.nested[].rules[].loads   number
projects[].resident.nested[].rules[].bytes   number
```

## agent-ledger

Version `agent-ledger@2`. Version 1 had no `cacheWrite1h` field and weighted every cache write at
1.25, so a version 1 ledger is on the older basis and its `weightedInput` differs from the report's
whenever a 1-hour write occurred. Version 2 adds `rows[].tokens.cacheWrite1h` and
`rows[].series.cacheWrite1h[]`. One file per machine. One `rows[]` entry per chain, where a chain is a
main conversation (one `<session>.jsonl`) or one subagent transcript
(`<session>/subagents/agent-<id>.jsonl`).

**Chain id.** `<repo>/<session8>/main` for a main chain, `<repo>/<session8>/<agent8>` for a
subagent, where `<agent8>` is the first 8 characters after `agent-` in the file name. It is a
composite of a repo label and two id prefixes, and is the only composite string allowed.

**Parent.** The `id` of the chain whose `Agent` tool call spawned this one: the chain in the same
session holding the `tool_use` whose `id` equals the meta file's `toolUseId`. null for a main
chain, and null when no chain in the session holds that `tool_use`.

**Turns.** A turn is exactly what the `report` command counts as a turn
(`transcript-events.ts`). A turn from a record whose usage `report` excludes as placeholder
(Claude Code before 2.1.307) still counts in `turns`, carries 0 in all four token columns, and
`counted` false.

**String policy.** Every string value in the file is one of: a tool name, a skill name, an agent
type, a model id, a fixed keyword listed below, the schema version `agent-ledger@2`, a session id prefix, a repo label, a chain id, an
ISO-8601 timestamp, or a path under `.claude/rules/`. Map keys follow the same policy. The script
asserts this before writing and exits non-zero on the first string outside it. No prompt text, no
file content, no URL, no title, no description, and no path outside `.claude/rules/`.

**Fixed keywords.**

- `machine`: a label given on the command line, `local` or `work`.
- `kind`: `main`, `subagent`.
- `effort`: `low`, `medium`, `high`, `xhigh`, `max`.
- Marker `kind`: `report`, `continue`, `ruling`, `artifact`.
- Report marker `status`: `WAVE_CLOSED`, `DONE`, `NEEDS_RULING`, `BLOCKED`, `PARTIAL`. Read as
  the token after the colon on a line of the form `PHASE <slug>/<N>: <status>`. Only the status
  token is kept, never the slug.
- Artifact marker `action` and `intent`: the call's own `action` and `intent` input values when
  each matches `^[a-z][a-z_-]{0,31}$`, and `other` when it does not. null when the input is absent.

**Markers, where each sits in the series.**

- `report`: on the turn that carries the orchestrator's report. Phase 1 step 7 records in the
  sub-plan Notes which chain and record that is.
- `continue`: on a chain's first turn after it receives a user message whose whole text, trimmed,
  is `continue`.
- `ruling`: on a chain's first turn after it receives a user message whose text starts with
  `Ruling:`.
- `artifact`: on the turn that holds the `Artifact` tool call.

**Repo totals.** `repos[].weightedInput` is weighted input over the repo's summed token
columns, rounded once, which is how `report` prints its total. A sum of the per-row rounded
`rows[].weightedInput` can differ from it by a few units per repo. The block's note for that key
predates this line, and this line wins.

**Series.** Column-major. Every array under `series` has exactly `turns` entries, index `i` being
turn `i` of the chain in transcript order.

```keys agent-ledger
schema                         string        "agent-ledger@2"
machine                        string        fixed keyword, local | work
generatedAt                    string        ISO timestamp of the run
repos[]                        object        one per repo walked
repos[].repo                   string        repo label
repos[].sessions               number        main transcripts walked
repos[].chains                 number        rows emitted for this repo
repos[].turns                  number        sum of rows[].turns
repos[].weightedInput          number        sum of rows[].weightedInput
repos[].placeholderTurns       number        sum of rows[].placeholderTurns
rows[]                         object        one per chain
rows[].id                      string        chain id
rows[].repo                    string        repo label
rows[].session                 string        session id prefix
rows[].kind                    string        fixed keyword, main | subagent
rows[].agentType               string|null   meta `agentType`, null for main
rows[].spawnDepth              number        meta `spawnDepth`, 0 for main
rows[].parent                  string|null   chain id, see Parent
rows[].model                   string|null   meta `model`, null for main or when absent
rows[].pickedEffortModel       string|null   meta `pickedEffortModel`, null when absent
rows[].effort                  string|null   the spawning Agent call's `effort` input, fixed keyword
rows[].turns                   number
rows[].placeholderTurns        number        turns whose usage was excluded
rows[].turnsByModel{}          number        keys are model ids
rows[].tokens                  object
rows[].tokens.input            number        fresh input
rows[].tokens.output           number
rows[].tokens.cacheRead        number
rows[].tokens.cacheWrite       number
rows[].tokens.cacheWrite1h     number        1-hour part of cacheWrite
rows[].weightedInput           number        see Shared definitions
rows[].firstTs                 string|null   ISO timestamp of the first turn
rows[].lastTs                  string|null   ISO timestamp of the last turn
rows[].tools{}                 object        keys are tool names
rows[].tools{}.uses            number        tool_use blocks emitted by this chain
rows[].tools{}.resultBytes     number        UTF-8 bytes of the matching tool_result content
rows[].skills{}                number        keys are skill names, value is Skill tool invocations
rows[].ruleLoads{}             object        keys are paths under .claude/rules/
rows[].ruleLoads{}.count       number
rows[].ruleLoads{}.bytes       number
rows[].series                  object        column-major per-turn series
rows[].series.ts[]             string|null   ISO timestamp
rows[].series.model[]          string|null   model id
rows[].series.input[]          number
rows[].series.output[]         number
rows[].series.cacheRead[]      number
rows[].series.cacheWrite[]     number
rows[].series.cacheWrite1h[]   number        1-hour part of cacheWrite
rows[].series.counted[]        boolean       false on a placeholder-usage turn
rows[].series.tools[]          array         tool names called on this turn, in order
rows[].series.tools[][]        string        tool name
rows[].series.markers[]        array         markers on this turn, empty when none
rows[].series.markers[][]      object        one marker
rows[].series.markers[][].kind string        fixed keyword
rows[].series.markers[][].status string|null report marker only
rows[].series.markers[][].action string|null artifact marker only
rows[].series.markers[][].intent string|null artifact marker only
rows[].series.markers[][].edits boolean|null artifact marker only, true when the call carried `edits`
rows[].series.markers[][].typed boolean|null artifact marker only, true when the call named a type
```
