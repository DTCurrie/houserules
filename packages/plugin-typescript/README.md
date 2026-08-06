# @agent-kit/plugin-typescript

[![npm](https://img.shields.io/npm/v/@agent-kit/plugin-typescript.svg)](https://www.npmjs.com/package/@agent-kit/plugin-typescript)
[![downloads](https://img.shields.io/npm/dm/@agent-kit/plugin-typescript.svg)](https://www.npmjs.com/package/@agent-kit/plugin-typescript)

An agent writing TypeScript reaches for `any` the moment data arrives from outside the
program, and picks between `interface` and `type` by whichever it saw last. Neither choice
fails a build, so neither gets caught in review until the codebase has both conventions and
no reason for either.

This plugin ships the small set of type-system decisions that have a right answer, as a rule
the agent loads only when it has a TypeScript file open.

## Install

```
pnpm add -D @agent-kit/plugin-typescript
pnpm exec agent-kit init
```

Requires [`@agent-kit/cli`](https://github.com/DTCurrie/agent-kit/tree/main/packages/cli).
`init` is what writes the module into `.claude/`. This module is off by default, so select it
when `init` asks.

## Modules

- **`typescript`** installs `.claude/rules/typescript.md`, a path-scoped rule covering three
  decisions. `interface` for object shapes, because they extend. `type` for unions and
  computed types. `unknown` plus a type guard instead of `any` for untyped external data.

  Scoped to `**/*.ts`, `**/*.mts`, and `**/*.cts` through its `paths:` frontmatter, and
  deliberately not `.tsx`. Claude Code loads it only when a matching file is in the working
  set, so it costs nothing on the always-loaded surface. Keep that frontmatter. A rule file
  without `paths:` is loaded on every turn.

  The rule assumes `strict: true`.

## What it leaves alone

Doc comments and verification commands are out of scope on purpose.

Doc comments belong to `code-comments.md` in
[`@agent-kit/plugin-prose`](https://github.com/DTCurrie/agent-kit/tree/main/packages/plugin-prose),
which covers TSDoc form in more depth than a per-language rule should restate. Running
`pnpm check` and `pnpm test` belongs to the CLAUDE.md managed region, which says it once per
turn rather than once per language rule that happens to load.

A rule that repeats something the kit already says costs resident budget every time it loads
to say it again. This one says only what is specific to TypeScript's type system.

## Part of agent-kit

[agent-kit](https://github.com/DTCurrie/agent-kit) is a portable kit of Claude Code
infrastructure that keeps the agent's context lean. This is one of eleven first-party plugins.
The [package list](https://github.com/DTCurrie/agent-kit#packages) has the rest.

## License

MIT. See [LICENSE](./LICENSE).
