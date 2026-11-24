# Manual mode: ask before the first spawn

In manual mode the session asks the user to approve each edit.
A subagent's edit raises its own permission prompt in the main session, so a wave of workers means
a stream of prompts the user answers one at a time. Say so once, before any spawn, then let the user choose.

## The signal

Run this branch when either holds:

- A line starting `[houserules] Manual mode` is in context. The `UserPromptSubmit` hook prints it
  when the user types `/orchestrate` in manual mode.
- The user said they approve each edit.

With neither, skip this file. A session that auto-accepts edits sees no change.

## The question

Before the first spawn, call `AskUserQuestion` with these options, and dispatch nothing until the
user answers:

- **Switch mode.** The user changes the permission mode, for example to accept edits, and says
  when done. Then dispatch as planned.
- **Run in-context.** You do the slices here, one at a time, with no worker. Every edit prompts as
  usual, and the user sees each one in the main session.
- **Continue anyway.** Dispatch as planned. Each worker edit prompts in this session.

Under `--auto` this is still a stop. Only the user can answer, and `--auto` does not answer for
them. Ask once per run. Do not ask again at each wave.

## A refused edit

When the user refuses a worker's edit, the worker cannot finish that file. It reports the slice
`BLOCKED` and names the path it could not write. Treat that as any `BLOCKED` slice: surface the
path, and do not retry the edit through another worker.
