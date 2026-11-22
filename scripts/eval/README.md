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

| Flag             | Default                                     | Meaning                                                                                                |
| ---------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `--paid`         | off                                         | Start real sessions. Needs `--api-key-file`, `--budget`, `--per-run`, `--margin`, `--out`.             |
| `--preflight`    | off                                         | With `--paid`, run the two haiku probes in place of samples. Refused unless `--per-run` is `0.02`.     |
| `--verdict-only` | off                                         | Judge the sessions already in `--out`. Refused with `--work`, `--paid`, `--preflight`, or `--no-slug`. |
| `--samples`      | 0                                           | Valid named-plan samples `--out` should hold. Only the missing ones start. Needs `--paid`.             |
| `--no-slug`      | off                                         | Also start the no-slug session, unless the ledger holds one. Needs `--paid`.                           |
| `--budget`       | required with `--paid`                      | Dollars the ledger may reach.                                                                          |
| `--per-run`      | required with `--paid`                      | Dollar cap per session, passed to the child as `--max-budget-usd`.                                     |
| `--margin`       | required with `--paid`                      | Overshoot ratio the meter adds to each cap.                                                            |
| `--work`         | `houserules-eval` in the OS temp directory  | Where samples are assembled. A `scratchpad` or `.artifact-work` segment is refused.                    |
| `--out`          | required with `--paid` and `--verdict-only` | Where session artifacts, `spend.jsonl`, and `verdict.json` go.                                         |
| `--rev`          | `HEAD`                                      | Revision whose CLI installs into each sample.                                                          |
| `--timeout-min`  | 20                                          | Minutes before a session's process group is killed.                                                    |
| `--api-key-file` | required with `--paid`                      | File holding the API key each paid session bills.                                                      |

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

## Spend ledger

Each `--out` holds `spend.jsonl`, one line per started session, with the session key's one field
(`sample`, `probe`, or `noSlug`), then `sessionId` (null when the session printed none) and
`costUsd`.

Before each session the meter adds the ledger sum to `--per-run` times one plus `--margin`. It
starts the session only when that total is at most `--budget`, and stops at the first refusal.

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
