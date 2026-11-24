# eval

Checks the orchestrate-report behavior of the shipped payload. It runs headless `claude -p`
sessions of `/orchestrate` on a fixed fixture, judges five claims mechanically from what the
sessions left behind, and prints PASS, FAIL, or INCONCLUSIVE for each claim.

This check is not part of `pnpm test` or any default gate. A session spends real money, and only
`--paid` starts one.

## Free run

```sh
node scripts/eval/run.mjs [--work <dir>] [--rev <rev>]
```

Without `--paid` the run builds the CLI at `--rev`, assembles one sample, runs its `plan-lint`,
and prints the command a session would use. It starts no session, spends nothing, and writes
nothing under `--out`. A pass proves the fixture assembles and the plan is valid.

## Paid runs

Every paid command takes a key file, a budget, a margin, and an output directory.

```sh
KEY=(--api-key-file ~/.config/houserules/eval-api-key --budget 5 --margin 0.2 --out <dir>)

# 1. Prove billing and the cap with two haiku probes.
node scripts/eval/run.mjs --paid --preflight "${KEY[@]}" --per-run 0.02

# 2. Run the samples, and the no-slug session.
node scripts/eval/run.mjs --paid --samples 3 --no-slug "${KEY[@]}" --per-run 1.5

# 3. Judge what `--out` holds, with no spend.
node scripts/eval/run.mjs --verdict-only --out <dir>
```

Preflight requires `--per-run 0.02`, because probe (b) must reach the cap. The samples need a
higher `--per-run`.

## Flags

| Flag             | Default                                     | Meaning                                                                                                                                                       |
| ---------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--paid`         | off                                         | Start real sessions. Needs `--api-key-file`, `--budget`, `--per-run`, `--margin`, `--out`.                                                                    |
| `--preflight`    | off                                         | With `--paid`, run the two haiku probes in place of samples. Refused unless `--per-run` is `0.02`.                                                            |
| `--verdict-only` | off                                         | Judge the sessions already in `--out`. Refused with `--work`, `--paid`, `--preflight`, or `--no-slug`.                                                        |
| `--samples`      | 0                                           | Valid named-plan samples `--out` should hold. Only the missing ones start. Needs `--paid`.                                                                    |
| `--no-slug`      | off                                         | Also start the no-slug session, unless the ledger holds one. Needs `--paid`.                                                                                  |
| `--budget`       | required with `--paid`                      | Dollars the ledger may reach.                                                                                                                                 |
| `--per-run`      | required with `--paid`                      | Dollar cap per session, passed to the child as `--max-budget-usd`.                                                                                            |
| `--margin`       | required with `--paid`                      | Overshoot ratio the meter adds to each cap.                                                                                                                   |
| `--work`         | `houserules-eval` in the OS temp directory  | Where samples are assembled. A `scratchpad` or `.artifact-work` segment is refused.                                                                           |
| `--out`          | required with `--paid` and `--verdict-only` | Where session artifacts, `spend.jsonl`, and `verdict.json` go.                                                                                                |
| `--rev`          | `HEAD`                                      | Revision whose CLI installs into each sample.                                                                                                                 |
| `--timeout-min`  | 20                                          | Minutes before a session's process group is killed.                                                                                                           |
| `--api-key-file` | required with `--paid`                      | File holding the API key each paid session bills.                                                                                                             |
| `--fixture`      | none                                        | Fixture directory holding `eval.json` and `repo/`. Requires `--arm`. Refused with `--preflight`, `--no-slug`, or `--verdict-only`.                            |
| `--arm`          | none                                        | The `eval.json` arm to run. Artifacts go to `<out>/<arm>/sample-<k>/`. Requires `--fixture`.                                                                  |
| `--sample`       | none                                        | Run exactly sample `<k>` of `--arm`. Requires `--fixture` and `--arm`. Refused with `--samples`, `--budget`, `--no-slug`, `--preflight`, or `--verdict-only`. |

## Fixtures and arms

`--fixture <dir> --arm <name>` runs one arm of a fixture in place of the orchestrate-report
samples. `<dir>/eval.json` names the `init --yes --modules` list, the `plugins` as
`{ path, alias }` with `path` relative to the built `--rev` root, the child's `model`, the
`validityAgent`, the `collect` paths, and `arms.<name>` as `{ prompt, overlay, model? }`, paths
relative to `<dir>`.

Each sample is a copy of `<dir>/repo/`. With plugins, a first `init --yes --modules core` seeds
the config, the runner adds each plugin as `{ "name": "<absolute path>", "alias": "<alias>" }`,
and a second `init` installs the full list. The arm's overlay mirrors paths under `.claude/` and
is copied over the install before the install commit. An overlay path the manifest does not
track stops the run. The arm's prompt file is the `-p` text, and its `model`, when set, replaces
the fixture's. Under `HOUSERULES_EVAL_CLI`, plugin paths resolve against the checkout that
`cli.js` sits in.

A sample is valid when its result is a success whose `subagent_stats.by_type` counts the
`validityAgent`, and every overlaid file still holds the overlay's bytes at exit. `run.json`
records `arm`, `model`, `validityAgent`, and `overlays` as
`{ path, initSha256, overlaySha256, exitSha256 }`. After the session exits, each `collect` path
that exists is copied into `<out>/<arm>/sample-<k>/tree/`. Ledger lines read
`{ arm, sample, sessionId, costUsd }`.

`--samples` counts only the arm's valid samples, while the meter sums the whole `--out` ledger,
so every arm and the probes spend against one `--budget`. A fixture run skips `plan-lint` and
`verdict.json`, and exits 0 when every session it started finished, or 2 when the meter refused
one. The free run assembles one sample and prints the child command on one line.

`--sample <k>` runs exactly sample `k` of the arm into `<out>/<arm>/sample-<k>/`. It takes no
`--budget`: under `--paid` it meters its one session against `--per-run` times one plus
`--margin` over `--out`'s own ledger, and it is refused when that directory exists. A free run
numbers the assembled sample `k`.

`eval.json` may set `network` to a boolean, default false. Unless it is true, the child runs
with `--disallowedTools WebFetch,WebSearch` and a `--settings` sandbox for Bash, and the dry
run's printed command shows both. The sandbox turns on `sandbox.enabled`, allows no domains,
and sets `sandbox.failIfUnavailable` and `sandbox.allowUnsandboxedCommands: false`, so the
session stops at startup instead of running Bash unsandboxed. Native Windows cannot sandbox,
and Linux and WSL2 need `bubblewrap` and `socat`. Claude Code documents the proxy's handling of
unlisted hosts per permission mode, and the strict deny key is read only from user or managed
settings, so a host-level refusal in every mode is not guaranteed.

## Actions

`.github/workflows/eval-probes.yml` runs probes from `workflow_dispatch`. Its inputs are `mode`,
`fixture`, `arms`, `samples`, `paid`, `per-run`, `margin`, `total-cap`, `max-parallel`,
`upload-transcripts`, `bench`, and `bench-args`. The scripts it calls are `actions-plan.mjs`, `actions-report.mjs`, and
`scrub.mjs`, each documented in its own header.

## Billing

Paid sessions bill the API key read from `--api-key-file`. The key is set only in each child's
environment, never in the parent's. The run refuses a missing, empty, or group- or other-readable
file, so `chmod 600` it first. Preflight fails any probe whose `system` init `apiKeySource` is
not `ANTHROPIC_API_KEY`, which catches a session that billed a subscription instead.

## Measured cost

On Claude Code 2.1.330:

- The two haiku probes cost about $0.02.
- A sample that nests costs about $1.05: dispatcher $0.29, phase-orchestrator $0.46, and three
  task-workers at about $0.10 each.
- A sample whose dispatcher stays inline costs about $0.20. It is void, because the claims need
  the nested layers.

Pick `--per-run` above the nested figure.

## When a step down holds

A step down is a cheaper cell (a lower model or effort) standing in for the cell it replaces. It
holds only when all three rules pass:

- The score is the fixture's acceptance: its hidden tests pass or fail per run, and nothing
  else is judged.
- The step down must cost at least 5% less than the cell it replaces, 5% of that cell's cost, to
  count.
- A run fails when its acceptance fails, or when its acceptance did not run after the run's last
  edit.

With zero failures in n runs, the one-sided 95% upper bound on the failure rate is
p = 1 - 0.05^(1/n), the p at which zero failures in n runs has a 5% chance. For n = 5, 0.05^(1/5)
is about 0.549, so p is about 45%. For n = 10, 0.05^(1/10) is about 0.741, so p is about 26%.
Five clean runs cannot rule out a failure rate of 45%, and ten cannot rule out 26%. Quality can
show only a gross collapse at these sample sizes, so cost carries the decision.

## Spend ledger

Each `--out` holds `spend.jsonl`, one line per started session, with the session key's one field
(`sample`, `probe`, or `noSlug`), then `sessionId` (null when the session printed none) and
`costUsd`.

Before each session the meter adds the ledger sum to `--per-run` times one plus `--margin`. It
starts the session only when that total is at most `--budget`, and stops at the first refusal.
A `--sample` run takes no `--budget`, so the meter holds the ledger sum to `--per-run` alone. A
second `--sample` run on an `--out` that already holds spend is refused. To run arms one sample
at a time against one ledger, raise `--samples` by one per call. Each call starts only the
samples that are missing.

The run holds `<out>/.lock`, which contains its pid. A second run on the same `--out` stops
while that pid is alive. A lock whose pid is dead is removed and the run proceeds.

Each `--out` has its own ledger and lock. A second caller that passes its own `--out` and
`--budget` spends against its own cap, and never against the first caller's.

## Exit codes

- `0`: the free run passed, the preflight passed, or every claim reads PASS.
- `1`: `plan-lint` failed, a preflight check failed, or a claim reads FAIL.
- `2`: the verdict is incomplete, or the run could not start. Causes are a bad flag, a refused
  path or key file, a held lock, a failed build, a session that could not spawn, or a preflight
  probe the meter refused.

## Test hook

`HOUSERULES_EVAL_CLI` names a prebuilt `cli.js` to install with in place of building `--rev`. It
skips the build, and the run then records no commit. It exists for tests.
