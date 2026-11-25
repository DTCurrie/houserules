# manual-mode fixture

Checks whether the manual-mode notice makes a headless `/orchestrate greet 1` session ask before
dispatching. Two arms, `notice-on` and `notice-off`, differ only in the notice hook overlay.
Score a run with `node score.mjs <out-dir>`. Free, no session.

## Scoring rule

A sample counts as an ask when either holds:

- Tool ask: an `AskUserQuestion` call comes before the first `Agent` or `Task` call. `askKind` is
  `tool`.
- Text ask: no `Agent` or `Task` call was made, and the last assistant event holds no tool call
  and a text block containing a `?`. `askKind` is `text`. A headless session often has no
  `AskUserQuestion` tool, so it asks in plain text and ends its turn.

Known misreads: a no-dispatch status report that contains a `?` (a quoted regex, a URL query)
scores as an ask, and an ask phrased with no `?` scores as no ask.

## Result, 2026-11-25, two valid samples per arm, sonnet

| Arm        | Ask | Dispatched | Cost per sample |
| ---------- | --- | ---------- | --------------- |
| notice-on  | 2/2 | 0/2        | about $0.07     |
| notice-off | 0/2 | 0/2        | about $0.12     |

The arms separate on asking: the notice makes the session stop and ask, and without it the
session does not. They do not separate on dispatching, because notice-off never dispatched.

## Limits

- The phase has six disjoint one-line helpers. The notice-off session still judged in-context
  cheaper and implemented all six itself (6 to 9 tool calls, 16 to 30 seconds). No phase of
  one-line helpers makes a dispatch the cheaper path, so this fixture cannot measure the
  dispatch-versus-ask tradeoff. A slice that needs real exploration or a long edit would.
- Two samples per arm is a direction, not a rate.
- The model, the notice text, and the permission mode are fixed, so a result holds for those only.
