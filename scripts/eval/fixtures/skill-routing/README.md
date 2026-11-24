# skill-routing eval suite

PAID. Measures whether a skill's `description` alone routes a natural-phrasing prompt to that
skill, under `claude plugin eval`. One case per payload skill in `cases/<skill>/`, 6 runs each, a
`tool_used: Skill` grader (skill fired) and an `llm` grader (the request was actually worked).

This is not an `eval.json` fixture for `scripts/eval/run.mjs`. `make-plugin.mjs` assembles the
plugin at run time (manifest, skills copied from the payload, `cases/` as `evals/`), so no copy of
a SKILL.md is committed.

Skills with `disable-model-invocation` (`chrome-devtools-mode`, `backlog-adopt`, `ledger-sync`,
tagged `manual-only`) assert the opposite: the Skill grader requires zero calls.

Run (phase 8, never in a test):

```sh
PLUGIN=$(node scripts/eval/fixtures/skill-routing/make-plugin.mjs)
claude plugin eval "$PLUGIN" --ablation with-without --max-cost-usd 15 --json "$PLUGIN/result.json"
```

Read the `tool_used: Skill` failures first: each one is a description that did not trigger on the
prompt's phrasing. In a two-arm run that grader is a plugin-fired indicator, not scored, so the
`llm` grader carries the score.

## Per-release readout

Free, no model call. Run once each release and record the figure:

```sh
node scripts/eval/fixtures/skill-routing/plugin-details.mjs
```

It builds the plugin, runs `claude plugin details` on it, and prints one line, for example
`always-on: 1683 tok (19 skills)`. The figure covers skill and agent descriptions only. Rules,
the houserules sections, and the CLAUDE.md region are not counted.
