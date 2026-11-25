# skills-dir-plugin

Probe P8 from `../skill-routing/OWNER-PROBES.md`: does a plugin under `.claude/skills/` load in a
headless eval child?

The fixture repo holds one plugin named `hr-probe` with one skill, under
`repo/.claude/skills/hr-probe/`. It sits in the repo and not in an overlay, because an overlay may
only replace a file `init` installed. The two arms share that repo and differ in one key of
`eval.json`:

- `trusted` sets `trustRunRoot`, so the runner gives the child its own config directory with the
  trust dialog accepted for the sample root.
- `untrusted` leaves it off, so the child runs under your own config, where a fresh sample root
  has never been trusted.

Read the result from each sample's `stream.jsonl`, in the `system` line whose `subtype` is `init`.
The plugin loaded when `plugins` holds an entry named `hr-probe` and `slash_commands` holds
`hr-probe:ping`. The expected reading is loaded in `trusted` and absent in `untrusted`.

Run one sample of each arm:

```
node scripts/eval/run.mjs --paid --fixture scripts/eval/fixtures/skills-dir-plugin --arm trusted --samples 1 --api-key-file ~/.config/houserules/eval-api-key --budget 1 --per-run 0.5 --margin 0.2 --out <dir>
```
