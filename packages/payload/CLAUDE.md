# packages/payload (@houserules/payload)

Working on the shared payload libs package. Payload authoring conventions, including the
package-name import rule, are in `docs/payload.md`.

- `@houserules/payload` holds the nine shared payload libs (`backlog-id`, `entry-ledger`,
  `config`, `ledger-index`, `proc`, `workspaces`, `comment-scan`, `findings`,
  `markdown-segment`) as their own package. It ships no modules and installs nothing on its
  own. A payload script, in the CLI or in a plugin, imports one by package name,
  `@houserules/payload/config`, and the build rewrites that specifier to the relative path
  the flattened `.claude/scripts/lib/` layout needs.
- The libs' own tests live at `payload/scripts/lib/__tests__/` in this package, not under
  `packages/cli`. Layout conventions are in `docs/testing.md`.
- This package has no `src/` at all, so it has no `tsconfig.build.json`, and its
  `tsconfig.json` extends `tsconfig.payload.json`, the reverse of the usual direction. The
  full tsconfig pattern is in `docs/package-checks.md`.
