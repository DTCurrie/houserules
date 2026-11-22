# bench

Measures how long houserules' code takes to run, on a build of a named commit. Each case is
timed as a whole process, node startup included, because that is what a user pays per hook call.

```sh
node scripts/bench/run.mjs --suite <hooks|cli|scripts|all> --out <file> [--commit <rev>] [--smoke]
```

| Flag       | Default  | Meaning                                                             |
| ---------- | -------- | ------------------------------------------------------------------- |
| `--suite`  | `all`    | One suite name, or `all`.                                           |
| `--out`    | required | Path of the JSON result.                                            |
| `--commit` | `HEAD`   | The revision to build and measure. Uncommitted edits are not built. |
| `--smoke`  | off      | 1 warmup run and 3 timed runs per case, to prove every case runs.   |
| `--runs`   | 20       | Timed runs per case. `--smoke` sets 3.                              |
| `--warmup` | 3        | Untimed runs per case before the timed ones. `--smoke` sets 1.      |

Exit codes:

- `0`: every case ran, and no case has the gate verdict `fail`.
- `1`: every case ran, and at least one case has the gate verdict `fail`. The JSON is written.
- `2`: setup error. The build failed, a fixture could not be made, or a case exited with a status
  outside its `expectExit`. The message goes to stderr, and the JSON is not written.

Accurate runs happen only with nothing else running on the machine. Inside a busy session, use CPU
profiles instead, because their shares hold under load.

## Profiling one case

```sh
node scripts/bench/run.mjs --profile <suite/case> [--commit <rev>] [--runs <n>] [--top <n>] [--interval <us>] [--out <file>]
```

This runs one case under node's CPU profiler instead of timing it, and prints the top frames by
self time as JSON. The case id is `<suite>/<name>`, the same id the result file uses. An unknown id
exits 2 and lists the valid ids.

| Flag         | Default  | Meaning                                                       |
| ------------ | -------- | ------------------------------------------------------------- |
| `--profile`  | required | The case id to profile.                                       |
| `--runs`     | 5        | Profiled runs, after one untimed warmup without the profiler. |
| `--top`      | 20       | How many frames to print.                                     |
| `--interval` | 100      | Profiler sampling interval in microseconds.                   |
| `--out`      | optional | Also write the JSON to this path.                             |

The profiler flags are appended to `NODE_OPTIONS`, keeping any value already set. Every node process
the case starts, child spawns included, writes one `.cpuprofile` into a fresh directory under
`<os.tmpdir()>/houserules-bench/profiles/`. That directory is never inside the build cache or the
repository, and it is kept so the files can be opened in a profiler.

The JSON object has these fields:

- `case`, `build` (`{ root, sha }`), `runs`, `interval`, and `profileDir`.
- `profiles`: `[{ file, totalMs }]`, one per profile file.
- `totalSelfMs`: self time summed over every profile.
- `topFrames`: `[{ functionName, url, line, selfMs, selfPercent }]`, merged across profiles by function
  name, url, and line, sorted by `selfMs` descending. `line` is 1-based and an anonymous function
  is `(anonymous)`. The `(program)` and `(garbage collector)` entries are kept.

Each sample is charged the time until the next sample, so the startup gap before the first sample
is not counted. Profiler overhead inflates every share a little, so read the shares and ignore the
absolute milliseconds.

## Scope cases

The `hooks` suite also holds three cases that time the build's own `lint-format-fix` over a real
tree, to show what `fix.passPaths` changes. They exist only when the build tree is not the live
repository, so no case edits the build or this checkout. Each runs in a standalone git repository
made from the build commit's tracked files, whose `node_modules` links into the build's. Every run
restores that repository and leaves one formatting edit in one `.ts` file under a configured target.

| Case                                | Fix commands                     | `passPaths` |
| ----------------------------------- | -------------------------------- | ----------- |
| `stop-lint-format-fix-scope-off`    | `lint:fix`, `format`             | off         |
| `stop-lint-format-fix-scope-on`     | `lint:fix:paths`, `format:paths` | on          |
| `stop-lint-format-fix-scope-on-dot` | `lint:fix`, `format`             | on          |

`lint:fix` is `eslint . --fix` and `format` is `prettier --cache --write .`. The fixture's root
`package.json` gains `lint:fix:paths` as `eslint --fix` and `format:paths` as
`prettier --cache --write`. On-dot shows the widening the schema warns of.

## Field scripts

Two self-contained scripts, Node built-ins only, read a machine's real history instead of timing a
fixture. Each runs from a file or piped over ssh. A shell that ssh starts for a command is not
interactive and may skip the profile that puts `node` on the PATH. If the remote side answers
`command not found: node`, name node by the full path `command -v node` prints on that machine.

- `scripts/bench/field-stop-runs.mjs` reads Claude Code transcripts and writes every
  `lint-format-fix` Stop run as `stop-runs@1` JSON Lines on stdout. It changes nothing.
  - `node scripts/bench/field-stop-runs.mjs <repo>... [--projects-dir <dir>]`
  - `node --input-type=module - <repo>... < scripts/bench/field-stop-runs.mjs`
- `scripts/bench/field-repro.mjs` times the steps the fixer would plan for a dirty set, once each,
  in check mode, and writes `fix-repro@1` JSON Lines. It changes no file in the checkout. Run it
  from the checkout's root.
  - `node scripts/bench/field-repro.mjs <path>...`
  - `node --input-type=module - <path>... < scripts/bench/field-repro.mjs`

## Timing

A node harness over `spawnSync`, timed with `process.hrtime.bigint()` around each spawn. `hyperfine`
was rejected because it is not installed here and would add an install step for every contributor.
The harness covers what `hyperfine` would: warmup runs, a robust spread statistic in place of
outlier trimming, and JSON output.

## The noise gate

The gate statistic is the relative median absolute deviation, `relMad = mad / median`.

| Setting      | Value  | Meaning                                                                      |
| ------------ | ------ | ---------------------------------------------------------------------------- |
| `threshold`  | `0.05` | A case with `relMad` above this fails. Equal to it passes.                   |
| `minSamples` | `10`   | Below this many timed runs the verdict is `insufficient`, which never fails. |

A spread estimated from fewer than 10 samples says nothing, so a `--smoke` run reports
`insufficient` for every case and exits 0 when every case ran.

## Statistics

All times are milliseconds, unrounded.

- `median`: the middle sample, or the mean of the two middle samples when `n` is even.
- `p95`: nearest rank, the sorted sample at index `ceil(0.95 * n) - 1`.
- `mad`: the median of `|sample - median|`.
- `relMad`: `mad / median`, and `0` when `median` is `0`.

## Result schema

```json
{
  "schemaVersion": 1,
  "createdAt": "2026-11-20T12:00:00.000Z",
  "mode": "smoke",
  "requested": "HEAD",
  "machine": {
    "node": "v24.16.0",
    "cpu": "Apple M3 Max",
    "cpus": 16,
    "os": "darwin 25.6.0",
    "arch": "arm64",
    "power": "ac",
    "commit": "<full 40-character sha>"
  },
  "build": { "root": "<absolute path of the build tree>", "cached": true },
  "settings": { "warmup": 1, "runs": 3 },
  "gate": { "statistic": "relMad", "threshold": 0.05, "minSamples": 10 },
  "cases": [
    {
      "id": "hooks/guard-bash",
      "suite": "hooks",
      "name": "guard-bash",
      "samplesMs": [41.2, 40.8, 42.0],
      "stats": {
        "n": 3,
        "median": 41.2,
        "p95": 42.0,
        "mad": 0.4,
        "relMad": 0.0097,
        "min": 40.8,
        "max": 42.0
      },
      "gate": "insufficient"
    }
  ],
  "verdict": "pass"
}
```

- `mode` is `smoke` or `full`.
- `machine.power` is `ac`, `battery`, or `unknown`.
- `cases[].gate` is `pass`, `fail`, or `insufficient`.
- `verdict` is `fail` when any case's `gate` is `fail`, otherwise `pass`.
- `cases` is ordered by suite, then by the order the suite returns its cases.

## Modules

| File                   | Exports                                                      |
| ---------------------- | ------------------------------------------------------------ |
| `run.mjs`              | the command above                                            |
| `build.mjs`            | `ensureBuild`, `findBuild`, `defaultCacheDir`, `BUILD_STEPS` |
| `stats.mjs`            | `GATE`, `summarize`, `gateVerdict`                           |
| `machine.mjs`          | `machineFacts`                                               |
| `timing.mjs`           | `measureCase`, `CaseError`                                   |
| `profile.mjs`          | `profileCase`, `mergeProfiles`, `selfTimeByFrame`            |
| `suites/index.mjs`     | `SUITES`, a map from suite name to a lazy import             |
| `suites/<name>.mjs`    | `cases`                                                      |
| `fixtures/<name>/`     | static fixture files for that suite only                     |
| `__tests__/*.test.mjs` | one test file per module, run by `test:scripts`              |

### `build.mjs`

- `ensureBuild(rev, { repoDir, cacheDir = defaultCacheDir(), steps = BUILD_STEPS })` resolves `rev`
  to a full sha in `repoDir`. On a cache hit it returns `{ commit, root, cached: true }` and runs
  nothing. On a miss it adds a git worktree of that sha under `os.tmpdir()`, runs each step in it,
  moves the built tree to `<cacheDir>/<sha>`, prunes the worktree registration, writes a completion
  marker last, and returns `cached: false`. A failed step removes the worktree and throws.
- `findBuild(rev, { repoDir, cacheDir = defaultCacheDir() })` resolves `rev` the same way and
  returns `{ commit, root }` when the completion marker exists, otherwise null. It never builds,
  adds a worktree, or writes under `cacheDir`, and `ensureBuild` uses it for its cache-hit check.
- `defaultCacheDir()` returns `<os.tmpdir()>/houserules-bench/builds`.
- `BUILD_STEPS` is `[[command, args], ...]`: install from the lockfile, then `pnpm build`.

### `stats.mjs`

- `GATE` is `{ statistic: 'relMad', threshold: 0.05, minSamples: 10 }`.
- `summarize(samplesMs)` returns `{ n, median, p95, mad, relMad, min, max }` as defined above. It
  throws on an empty array.
- `gateVerdict(stats, gate = GATE)` returns `'insufficient'` when `stats.n < gate.minSamples`,
  `'fail'` when `stats.relMad > gate.threshold`, otherwise `'pass'`.

### `machine.mjs`

- `machineFacts(commit)` returns the `machine` object in the schema. It never throws. A fact it
  cannot read is `'unknown'`.

### `timing.mjs`

- `measureCase(benchCase, { warmup, runs })` runs `benchCase.beforeEach` before every run, untimed,
  then spawns the case. Warmup runs are discarded. It returns `{ samplesMs }` with `runs` entries.
- It throws `CaseError` naming the case when a run exits with a status outside `expectExit`, is
  killed by a signal, or passes `timeoutMs`. The message includes the tail of stderr.

### A case

`cases(context)` in each suite returns `Promise<BenchCase[]>`. The `context` is
`{ root, repoDir, workDir }`:

- `root`: the build tree from `ensureBuild`. Read it, never write it.
- `repoDir`: the live repository, for files the build tree lacks, such as `.claude/settings.json`.
  Read it, never write it.
- `workDir`: an empty temporary directory this suite may write fixtures under. `run.mjs` creates it
  and removes it after the suite.

A `BenchCase` is:

| Field        | Type               | Meaning                                                 |
| ------------ | ------------------ | ------------------------------------------------------- |
| `name`       | string             | kebab-case, unique within the suite                     |
| `command`    | string             | the executable, such as `process.execPath` or `/bin/sh` |
| `args`       | string[]           | its arguments                                           |
| `cwd`        | string             | under `workDir`                                         |
| `env`        | object, optional   | merged over `process.env`                               |
| `stdin`      | string, optional   | written to the process's stdin                          |
| `expectExit` | number[], optional | the accepted exit statuses, `[0]` by default            |
| `beforeEach` | function, optional | untimed setup before every run, such as a fresh fixture |
| `timeoutMs`  | number, optional   | per run, `60000` by default                             |

A case never touches the network, the live repository, `~/.claude`, or a ledger. A command that
would reads its inputs from a fixture under `workDir` instead. Every suite merges
`sandboxEnv(<workDir>/home)` from `suites/sandbox-env.mjs` into each case's `env`, which is
what keeps pnpm, corepack, and `doctor`'s npm version lookup off the network.
