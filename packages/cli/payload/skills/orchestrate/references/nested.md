# The nested layer

Open this when `/orchestrate` was invoked with `--nested`. `SKILL.md` §4 names the flag. This
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
`Rulings made`, `Backlogged`, `Decide candidates`, `Resume`. The format itself closes
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
