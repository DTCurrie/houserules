# Owner probes for the skills-directory plugin (path D)

Four probes need a person, a browser, or a harness change. Each assumes a fixture repo with
`.claude/skills/hr-probe/` holding `.claude-plugin/plugin.json`, `skills/ping/SKILL.md`,
`agents/probe.md`, and `hooks/hooks.json` with a SessionStart hook that echoes `[hr-probe] hook`.

## P1: untrusted interactive

- Action: clone the fixture fresh. Remove any `projects["<clone path>"]` entry from
  `~/.claude.json`. Run `claude` in the clone. Before you accept the trust dialog, run `/plugin`.
- Decides it: `/plugin` must not list `hr-probe@skills-dir`. Accept the dialog, run
  `/hr-probe:ping`. The skill must run and `[hr-probe] hook` must print. A listed plugin before
  trust, or a missing one after, fails it.

## P5: cloud

- Action: push the fixture with the plugin committed to a private repo. Start a session on it at
  claude.ai/code. Ask for `/hr-probe:ping`, then for the `/plugin` list.
- Decides it: the skill runs and `hr-probe` is listed means the plugin loads in cloud. A missing
  skill means the inference that cloud does not load skills-dir plugins holds.

## P6: mid-session write

- Action: open `claude` in a repo with no plugin dir. From Bash, write `.claude/skills/hr-probe/`
  (`plugin.json` and one skill). Try `/hr-probe:ping`. Run `/reload-plugins`. Try it again. Then
  edit that `SKILL.md` and run the skill once more.
- Decides it: before reload the command must be missing, after `/reload-plugins` it must run, and
  the `SKILL.md` edit must show on the next run without a reload. Any other order fails it.

## P8: eval harness

- Action: needs a `scripts/eval` fixture arm that installs path D, and `run.mjs` setting
  `projects["<run root>"].hasTrustDialogAccepted` in the child's config. `run.mjs` does not set
  that key today, so add it first. Then run one paid session at the smallest budget, for example
  `node scripts/eval/run.mjs --paid --fixture <fixture> --arm <arm> --samples 1 --api-key-file ~/.config/houserules/eval-api-key --budget 1 --per-run 0.5 --margin 0.2 --out <dir>`.
- Decides it: the child's `system/init` line in `stream.jsonl` lists the plugin under `plugins`
  with source `hr-probe@skills-dir`, and `plugin_errors` is null. Without the trust key the plugin
  is absent, which is the failure.
