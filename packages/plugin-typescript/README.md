# @agent-kit/plugin-typescript

An agent-kit plugin contributing one module:

- `typescript`: a path-scoped rule covering the TypeScript type-system decisions that have a
  right answer. `interface` for object shapes since they extend, `type` for unions and
  computed types, and `unknown` plus a type guard instead of `any` for untyped external data.
  Scoped to `**/*.ts`, `**/*.mts`, and `**/*.cts`, so it loads only when a matching file is in
  the working set and costs nothing on the always-loaded surface.

Doc comments and running the verification commands are deliberately out of scope. Doc comments
are `code-comments.md`'s job if that rule is installed, and verification is the CLAUDE.md
managed region's job. This rule says only what is specific to TypeScript's type system.
