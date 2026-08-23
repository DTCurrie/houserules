# Testing layout

How tests are laid out and staged across every package in this workspace. Read this before
writing, moving, or staging tests. The shared test package's own inventory lives in
`packages/test/CLAUDE.md`.

- Tests live in a `__tests__/` **beside the code they are about**, per
  `packages/plugin-testing/payload/rules/testing.md` which this repo dogfoods. The split is
  by SUBJECT, not by unit-versus-e2e: a fixture-driven CLI test is still a test of its one
  subject, so `src/commands/__tests__/modules.test.ts` holds both the pure `parseRequested`
  cases and the ones that drive the command against a real tree. Never add a `.e2e.test.ts`
  tier. If a file gets unwieldy, split it by CONCERN.
- **The filename names the unit, and every `describe` in it is about that unit.** A file named
  for a theme is a grouping, and a grouping hides which unit is covered. In `packages/cli`:
  `src/**/__tests__/`, `src/modules/__tests__/` (named for the module it covers),
  `src/commands/doctor/__tests__/` (one file per doctor check), `payload/scripts/__tests__/`,
  and `payload/__tests__/` for the two invariants over the whole built tree (`dependencies`,
  `execution`). The shared libs' own tests live at
  `packages/payload/payload/scripts/lib/__tests__/` in the standalone `@houserules/payload`
  package, not under `packages/cli/payload/scripts/lib/`, which does not exist.
- Import the shared testing modules via the **`#test/*` alias**, which resolves into
  `packages/test`. The mapping and the module inventory are in `packages/test/CLAUDE.md`.
- Stage with `useInstalledRepo()`, which copies a cached post-`init` snapshot, rather than
  running `init` in a test that is not about `init`. Otherwise one `init` regression fails
  twenty unrelated suites and names the wrong thing. `useRepo()` gives a bare repo.
- Test files carry **no comments and no file header**. The `describe` name, the `it` name, and
  a named helper are the three places meaning goes.
- Keeping tests out of published tarballs is build wiring, not layout: see
  `docs/package-checks.md`.
