# ledger-batch

Two arms of the ledger skills' reviewer clause. `batch` is the shipped text of `backlog-add` and `decide`, which says to spawn one reviewer after the last add when a turn adds several entries. `per-entry` is the same two files with that sentence removed. The prompt is byte-identical in both arms: three backlog entries and one decision in one turn.

Score a run with `node scripts/eval/fixtures/ledger-batch/score.mjs <out>`. It prints reviewer spawns, ledger rows, cost, and wall per sample.

## No ledger write reaches GitHub

- The fixture installs only the `backlog` and `decisions` plugins. `plugin-github`, which holds `projects-sync.mjs` and its hook, is not installed, so the sample has no sync script.
- `backlog-log.mjs` and `decision-log.mjs` only append to `.claude/ledgers/*.jsonl`. Neither calls the network.
- The sync hook spawns a push only when the enable token file exists in the ledger directory (`hasSyncToken` in `projects-sync-hook.mts`). A sample's ledger directory holds only `.gitignore`, so there is no token.
- `eval.json` sets `network` false, so the child also runs with WebFetch and WebSearch denied and a Bash sandbox with no allowed domains.

## Cost

Expected about $0.50 per run at haiku, so `--per-run 0.60` leaves room for the margin. The issue names a ceiling of 300 s and $0.06 for this set. Read it against the difference between arms, not as the per-run cap.
