# packages/test (@houserules/test)

Working on the shared testing modules. Repo-wide test layout conventions are in
`docs/testing.md`.

- One module per artifact: `repo` (builds the synthetic repos), `run` (`runCli`,
  `runScript`, `runIn`), `installed-tree`, `doctor-report`, `runner-stub`, `hook-input`,
  plus `global-setup`. It holds **no tests of its own**: every suite that imports one
  exercises it. `vitest` is a peerDependency, so its tarball ships an import of it on
  purpose.
- Consumers import via the **`#test/*` alias**, which resolves into this package. Mapped in
  each consumer's `vitest.config.ts` (`resolve.alias`, a regex prefix so a new module needs
  no config change) and `tsconfig.json` (`paths`). `packages/cli` keeps one local module,
  `ctx-builder`, under its own `test/`, so its config maps `#test/ctx-builder` ahead of the
  general prefix. Not in `package.json` `imports`, which would publish a mapping to files
  the package does not ship.
- Its single `tsconfig.json` does both the check and build jobs, one of the two recorded
  exceptions to the two-tsconfig split in `docs/package-checks.md`.
