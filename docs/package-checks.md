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
- Root `check` is `check:types` plus `verify`. `check:types` is the per-package typecheck
  aggregator. `verify` is the list of post-build assertions `pnpm check` and CI share, and it
  depends on `build`, so a cold `pnpm check` builds first. CI's `lint` job runs `check:types`
  alone and its `packages` job runs `verify`. The list itself lives in the root
  `package.json`, not here.
- `verify:tarballs` stays out of `verify`. It runs `npm pack` once per publishable package, in
  series, and what it checks moves only with a `files` array, a test exclude, or the build
  layout. CI's `packages` job runs it after `verify`. The `package.json` field check it used to
  carry is `verify:package-manifests`, a plain JSON read inside `verify`. `pnpm release` runs
  both scripts with plain `node` before `changeset publish`, so a wireit cache hit can never
  skip them on the way to npm.
- Wireit's declared `output` plus its default `clean: true` is what guarantees a deleted
  source ships no orphan, replacing the old `rm -rf` prefixes. The CLI's `build` also runs
  `publint` after assembling `payload-dist/`.
- Root `pnpm build|test|check` are wireit aggregators that depend on each package's script
  by path, replacing `pnpm -r`. The three lists differ on purpose: `build` names all
  eighteen packages, the per-package typecheck behind `check` seventeen, and `test` sixteen. The thin `houserules` package has
  no source, so it carries only `build`, and `@houserules/test` ships no `test` script. Naming
  a script that does not exist is a wireit error rather than the no-op `pnpm -r` gave you.
  Root `test` is the one exception to "the command is `wireit`". It runs
  `scripts/capped-wireit.mjs`, which sets `WIREIT_PARALLEL` to a quarter of the cores, never
  under 2, and then runs the `test:all` aggregator. Wireit's default of twice the cores starts
  every package's vitest pool at once, and tests then time out. Set `WIREIT_PARALLEL` yourself
  to override the cap. Root `lint` is also
  wireit, and `lint:fix`, `format`, and `format:fix` stay plain scripts. A bare tool name
  checks, `:fix` writes, and `:fix:paths` writes only the paths passed. Checks whose inputs
  can be declared run through wireit, while fixers and the repo-wide prettier call the tool
  directly. A fixer mutates
  its own inputs, so caching it is wrong, and a repo-wide formatter's input set is
  `.prettierignore`, which should not be restated in `package.json` where the two would
  drift.

## The two-tsconfig split

- **Tests must never reach the published package**, and a green suite will not catch it.
  `tsconfig.build.json` excludes `src/**/__tests__/**` and `tsconfig.payload.json` excludes
  `payload/**/__tests__/**`, since `dist/` and `payload-dist/` are both `files` entries. A
  shipped test would carry a `vitest` import into a user's install. `tsconfig.json` clears
  the inherited exclude so `pnpm check` still typechecks them. Verify with
  `pnpm verify:tarballs`, which packs real tarballs, not with `find` over `dist/`.
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
