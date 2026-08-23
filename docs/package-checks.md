# Package check wiring

How a package's `build`, `check`, and `test` are wired: the wireit blocks, the tsconfig
shapes, and what keeps tests out of published tarballs. Read this before adding or editing
any package's tsconfig, wireit block, or scripts.

## Wireit

- Every `build`, `check`, and `test` script runs through
  **[wireit](https://github.com/google/wireit)**, which owns the dependency graph and the
  incremental skipping. Each script declares its `dependencies`, its input `files`, and its
  `output` in a `wireit` block in the same `package.json`. Two consequences worth
  internalizing. A script whose inputs are unchanged is **skipped**, so a second `pnpm test`
  costs about 0.3s rather than 26s, and a `--filter`ed command pulls that package's upstream
  builds in on its own. And a `files` glob that misses a real input fails **silently**, by
  skipping work that should have run, so add the glob the same day you add the input.
- Wireit's declared `output` plus its default `clean: true` is what guarantees a deleted
  source ships no orphan, replacing the old `rm -rf` prefixes. The CLI's `build` also runs
  `publint` after assembling `payload-dist/`.
- Root `pnpm build|test|check` are wireit aggregators that depend on each package's script
  by path, replacing `pnpm -r`. The `test` aggregator lists **fifteen** packages, not
  sixteen, because `@houserules/test` ships no `test` script and naming a script that does
  not exist is a wireit error rather than the no-op `pnpm -r` gave you. Root `lint` is also
  wireit, and `lint:fix`, `format`, and `format:check` stay plain scripts. A fixer mutates
  its own inputs, so caching it is wrong, and a repo-wide formatter's input set is
  `.prettierignore`, which should not be restated in `package.json` where the two would
  drift.

## The two-tsconfig split

- **Tests must never reach the published package**, and a green suite will not catch it.
  `tsconfig.build.json` excludes `src/**/__tests__/**` and `tsconfig.payload.json` excludes
  `payload/**/__tests__/**`, since `dist/` and `payload-dist/` are both `files` entries. A
  shipped test would carry a `vitest` import into a user's install. `tsconfig.json` clears
  the inherited exclude so `pnpm check` still typechecks them. Verify with a real
  `pnpm pack` and grep the tarball, not with `find` over `dist/`.
- **Most packages use that same two-tsconfig split, and where both jobs exist one tsconfig
  may never do both.** Two are exceptions, and they are exceptions for a reason rather than
  by drift. `packages/payload` has no `src/` at all, so it has no `tsconfig.build.json`, and
  its `tsconfig.json` extends `tsconfig.payload.json`, the reverse of the usual direction.
  `packages/test` has a single `tsconfig.json` doing both jobs, because it ships no payload
  and its consumers import it through `#test/*`. Check which shape a package has before
  writing a path into a brief. A slice brief written from the old wording sent a worker to
  edit a `tsconfig.build.json` that does not exist.
  `tsconfig.build.json` is the EMIT config: it excludes tests so they stay out of `dist/`.
  `tsconfig.json` is the CHECK config: it `extends` the build one, sets `noEmit` and
  `rootDir: "."`, clears the exclude with `exclude: []`, and lists **both** test locations in
  `include`, `src/**/*.ts` and `payload/**/__tests__/**/*.ts`. Drop the payload glob and the
  hook-script suites silently go unchecked, which is not hypothetical: four packages had
  drifted off this pattern and `pnpm check` was skipping five suites entirely. Vitest strips
  types rather than checking them, so nothing else would have caught it. A package's wireit
  `build.files` names `tsconfig.build.json` and its `check.files` names both.

## The third (payload) tsconfig

- **A package that ships payload scripts has a THIRD tsconfig, and `check` must run it too.**
  `tsconfig.payload.json` compiles `payload/**/*.mts` to `payload-dist/`, and its options are
  genuinely different: its own `rootDir` and `outDir`. Those cannot be folded into the check
  config, so `check` runs both projects:
  `tsc --noEmit -p tsconfig.json && tsc --noEmit -p tsconfig.payload.json`. Its `files` names
  `payload/**/*.mts` and `tsconfig.payload.json`, and its `dependencies` names
  `../payload:build`, without which a `@houserules/payload/*` import resolves nothing. **No
  plugin carries a `rootDirs` line any more.** Six of them did, each pairing
  `./payload/scripts` with `../cli/payload-dist/scripts`, a relative path into a sibling's
  build output that existed only inside this monorepo and that a third-party author had no
  way to write. Package-name imports plus the `houserules-payload` rewrite replaced all six.
  Do not add one back. Not hypothetical either: six plugins ran `check` over `src/` alone, so
  26 payload sources including the largest script in the workspace were never typechecked by
  it. `build` caught them, which is why nothing was broken, but `check` is the gate that runs
  first and it was reporting green on files it had not read.
