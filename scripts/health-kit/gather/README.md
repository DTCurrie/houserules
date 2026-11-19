# Gather scripts

Four scripts and `SCHEMA.md`, with every pass-specific path and
label turned into a required argument. Node builtins only. Each script's header comment is its
invocation contract. A missing required argument prints a usage line and exits 2. Keep `SCHEMA.md`
beside the scripts, because `parse-usage-report.mjs` and `agent-ledger.mjs` read their key lists
from it.

Run order, with `$K` for this directory, `$W` for the pass workspace, and `$P` for the directory
that holds the installs:

1. Raw reports. Run `houserules report` from each install root, one text file per repo, named
   `$W/baseline/local-report-<repo>.txt`. The scripts below read those files.
2. `node $K/assemble-local-report.mjs --reports $W/baseline --out $W/imports/local-report-<date>.md --projects-root $P --repos <a,b,c> --cli-version <x.y.z> --date <YYYY-MM-DD> --older-than <x.y.z>`
3. `node $K/parse-usage-report.mjs $W/imports/local-report-<date>.md $W/baseline/usage-local.json`
4. `node $K/parse-usage-report.mjs $W/imports/work-report-<date>.md $W/baseline/usage-work.json`
5. `node $K/agent-ledger.mjs --machine local --out $W/baseline/agent-ledger-local.json $P/<repo> $P/<repo2>`
6. `node $K/check-agent-ledger.mjs --ledger $W/baseline/agent-ledger-local.json --reports $W/baseline --projects-root $P`

On a work machine, run `agent-ledger.mjs` alone with `--machine work`. It reads `~/.claude`, or
`CLAUDE_CONFIG_DIR`, and writes only `--out`. It keeps no prompt text, file content, URL, title, or
path outside `.claude/rules/`, so its output can leave the machine.

## Known defect in the workspace `cost-map.mjs`

`cost-map.mjs` is not in this kit. Its D2 check compares raw transcript records with deduplicated
turns, so it cannot validate a session against a ledger the current `agent-ledger.mjs` writes,
which counts one turn per API request. A pass that copies that script repairs the comparison first.

## Schema bump to `agent-ledger@2`

The ledger weights input the way the report does: 1-hour cache writes at 2, 5-minute writes at
1.25, reads at 0.1. Version 2 adds `rows[].tokens.cacheWrite1h` and `rows[].series.cacheWrite1h[]`,
read from `usage.cache_creation.ephemeral_1h_input_tokens`. The ledgers written by the 2026-11-18
pass are `agent-ledger@1`, on the older basis that weights every cache write at 1.25. Their
`weightedInput` does not equal a current report's total. `check-agent-ledger.mjs` reads an `@1`
file on that flat basis and an `@2` file on the report's basis.
