# The nested layer

Open this on every `/orchestrate` run without `--flat`. `SKILL.md` §4 names the default. This
carries the brief going down, the report coming up, the gates one layer down, and what the main
conversation does with each report. The `phase-orchestrator` agent runs the skill itself, one layer
down, and `agents/phase-orchestrator.md` carries only its delta over the skill.

## The brief, going down

One `Agent` call with `subagent_type: phase-orchestrator`, no `model` override, one phase per spawn.
The message is these lines, in this order, and nothing else. Never the plan text. The orchestrator
reads `.claude/plans/<slug>/` from disk, exactly as the skill does.

```
Plan: <slug>
Phase: <N>
Mode: check-in | auto
Gates: none | <ignored gate keys, comma-separated>
Domain: all | <path roots the orchestrator and its workers may write, comma-separated>
Siblings: none | <the domains of the other orchestrators in flight>
Seam: none | <paths the layer above wrote, comma-separated>
Ruling: <on a resume only: the answer to the last NEEDS_RULING, verbatim>
```

## The report, coming up

The first line is `PHASE <slug>/<N>: WAVE_CLOSED <n>/<total> | DONE | NEEDS_RULING | BLOCKED | PARTIAL`.
The sections follow in this order: `Status table`, `Landed`, `Verify`, `Ruling needed`,
`Rulings made`, `Backlogged`, `Out of scope`, `Requests`, `Decide candidates`, `Resume`. The format itself closes
`agents/phase-orchestrator.md`.

## Gates, one layer down

Each point where the skill stops for the user becomes a return. `RESLICE` and the two-round revise
cap stay nested, because they are the orchestrator's own calls, not the user's.

| Gate            | Where the skill stops today                                   | Nested status                                                                                               |
| --------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `plan-tie`      | §0 step 4, two plans in flight and no slug                    | resolved above the spawn, since the brief carries `Plan:`. A `Plan:` with no workspace on disk is `BLOCKED` |
| `check-in`      | §8, between phases                                            | `DONE`, the pause lives at the main conversation                                                            |
| `blocked-slice` | §7, a slice marked `BLOCKED`                                  | `NEEDS_RULING`                                                                                              |
| `needs-context` | §5, a worker's `NEEDS_CONTEXT` the plan on disk cannot answer | `NEEDS_RULING`                                                                                              |
| `context-size`  | §8, past roughly half the window                              | `PARTIAL`, after the current wave closes                                                                    |
| `depth-limit`   | preflight, `Agent` withheld from the orchestrator             | `BLOCKED`, naming `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`                                                    |

## The main conversation

**Dispatch.** One `Agent` call with `subagent_type: phase-orchestrator`, no `model` override, and
the brief above. One phase per spawn. The agent id comes from the dispatcher's own `Agent` result.
Every later message to this orchestrator goes to that id with `SendMessage`.

**Relay.** Print `Status table` verbatim, with no prose over it. Put one line under it for anything
the columns cannot carry. Then act on the first line of the report:

- `WAVE_CLOSED`: send `continue` with `SendMessage`.
- `DONE`: run `/decide` and `/pr-description` at this layer, from `Decide candidates`, with
  `/pr-description` after the last phase only. Under `all`, spawn the next phase's orchestrator
  with a fresh brief. Check-in mode stops for the user first. The fresh spawn doubles as the
  context-size gate, because the new orchestrator starts with an empty context.
- `NEEDS_RULING`: the round trip below.
- `PARTIAL`: spawn a fresh orchestrator with the same brief. It resumes from the plan workspace.
- `BLOCKED`: surface the report to the user. Never reword the cause.

**The ruling round trip.** Relay `Ruling needed` verbatim through `AskUserQuestion`, with the
recommendation first. Never summarize it, because the orchestrator wrote the options with context
you do not have. Send the answer back as a `Ruling:` line with `SendMessage` to the same agent id.
Never respawn for a ruling, because the same id keeps its context.

**Interim notifications.** A notification saying the orchestrator awaits its own background work is
interim. Wait for its final report, because reviewing the interim one judges a phase that has not
finished.

**Preflight.** A `BLOCKED` report naming `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` means the depth limit
withheld `Agent` from the orchestrator. Set the variable and spawn fresh with the same brief. A
re-brief changes nothing.

## Several orchestrators

Run two or more orchestrators at once only when each phase fits a domain of its own. Dispatch them
in one message, one `Agent` call each, and keep every agent id. All the single-orchestrator rules
above hold per agent.

**Domains.** `Domain:` is the set of path roots an orchestrator and its workers may write. Draw
domains by the shared-resource rule in `slicing.md`, so no path root is in two domains. Name
everything two domains might both write, and keep it out of every domain: lockfiles, root config,
generated indexes, and the ledgers belong to the main conversation. `Siblings:` carries the other
orchestrators' domains, so a worker that finds a defect there reports it under `Out of scope` and
leaves it. Two orchestrators never share a plan workspace. Each plan's `ROADMAP.md` belongs to the
orchestrator driving it.

**The cross-domain seam.** Before dispatching either orchestrator, write what both domains depend
on and pass the paths on the `Seam:` line. That is shared types, route contracts, and config keys,
which is the skill's §2 one level up. A backend phase and the frontend phase that consumes it get
the API contract on disk first. Neither orchestrator edits the seam. A change one needs comes up as
a `Requests` line, and the main conversation applies it, then sends the other orchestrators whose
work it touches a `SendMessage` naming the changed path.

**The barrier, split.** Each orchestrator runs its §7 fixer and `/tidy` over its domain's paths and
verifies by an explicit `--filter` over its domain's packages, never repo-wide. It never runs
`/verify-changed` there, because that scopes by `git diff`, which with siblings mid-edit pulls in
their packages. Where `fix.filterFlag` is empty and the fixer cannot scope by package, run the
formatter and `eslint --fix` on the domain's paths directly. Two cold `pnpm --filter <pkg> test` runs on disjoint
packages that shared upstream builds finished green together, so the scoped verifies run
concurrently. Wireit holds no cross-process lock, so a verify that fails on build state instead of
a test is rerun once alone before it is judged. After every orchestrator has returned `DONE`, the
main conversation runs the repo-wide fixer and `/verify-changed` once. That run is the only
whole-tree proof.

**The merged table.** Each time any orchestrator returns, print one table with a `Plan` column
first, then every orchestrator's latest rows verbatim:

```markdown
| Plan   | Slice            | Owns                  | State      |
| ------ | ---------------- | --------------------- | ---------- |
| api    | 1a route schema  | `packages/api/src/**` | ✅ done    |
| client | 1a fetch wrapper | `packages/web/src/**` | 🔄 running |
```

An orchestrator that has not returned since the last printing keeps the rows it last returned.

**Rulings.** Relay each `NEEDS_RULING` tagged with its plan and phase, and resume only the agent
that asked, by its own id. The others keep running, and a `WAVE_CLOSED` from one gets its
`continue` without waiting on the ruling.

**Ledgers and lint.** `/backlog-add` stays nested. The ledger takes one appended line per entry,
and its `.md` surface is a render the next call rebuilds. `Decide candidates` travel up. Each
orchestrator runs `plan-lint.mjs` after it updates its own workspace. The checker scans every
workspace and takes no path, so a finding in a sibling's workspace goes under `Out of scope`.
