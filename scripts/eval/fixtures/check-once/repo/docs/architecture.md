# Architecture

`bin/tally.mjs` parses `process.argv` and calls into `src/`. Counting lives in `src/count.mjs`.
Each command keeps its own module under `src/commands/`. Configuration is read once from
`tally.config.json` by `src/config.mjs`.

Files are read whole. There is no streaming, so very large inputs are out of scope.
