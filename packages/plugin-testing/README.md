# @agent-kit/plugin-testing

[![npm](https://img.shields.io/npm/v/@agent-kit/plugin-testing.svg)](https://www.npmjs.com/package/@agent-kit/plugin-testing)
[![downloads](https://img.shields.io/npm/dm/@agent-kit/plugin-testing.svg)](https://www.npmjs.com/package/@agent-kit/plugin-testing)

An agent asked to fix a bug will often write a test that passes before the fix and after it,
which proves nothing. Left alone, it also drifts toward asserting `toBeDefined()`, chasing a
coverage number, or filing a unit test as end-to-end because the distinction was never stated.

This plugin ships a testing discipline rule that does not assume a framework. It covers
whether a test is worth writing, where it lives, what it should assert, and how it is named,
for any runner with a `describe`/`it` shape, plus opt-in guides for the languages that need
suffix and build-exclusion detail the base rule leaves out.

## Install

```
pnpm add -D @agent-kit/plugin-testing
pnpm exec agent-kit init
```

Requires [`@agent-kit/cli`](https://github.com/DTCurrie/agent-kit/tree/main/packages/cli).
`init` is what writes the module into `.claude/`. This module is off by default, so select it
when `init` asks.

## Modules

- **`testing`** installs `.claude/rules/testing.md`, a path-scoped rule matched to
  `*.test.ts`, `*.test.tsx`, `*.test.mts`, `*.test.js`, `*.test.mjs`, and the `.spec.*`
  equivalents. It covers whether a test earns its place (it has to fail when the behavior it
  covers breaks), where tests colocate (`__test__/`, split by subject), what to test and at
  what level, Arrange/Act/Assert structure, and naming that states the observable behavior
  rather than the implementation.

  `init` also prompts for language guides to install alongside it. Four exist today:
  **TypeScript** (`testing-typescript`) and **JavaScript** (`testing-javascript`), each
  installed as its own path-scoped rule with the concrete suffix list, runnable examples, and
  build-exclusion advice the base rule leaves to them; **Svelte** (`testing-svelte`), runner
  setup for testing Svelte 5 components and `.svelte.ts` reactive modules; and **3D and WebGL**
  (`testing-3d`), domain guidance for tests that cover Three.js scenes and other WebGL code.
  TypeScript is selected by default.

  Because the rule is path-scoped, Claude Code loads it only when a matching test file is in
  the working set, so it costs nothing on the always-loaded surface.

## Upgrading from the CLI core

`testing` was a built-in CLI module. A repo that recorded it before the split gets a
`KitError` on its next `init` or `update` naming this package. Installing it and adding it to
the `plugins` array in `.claude/kit.config.json` restores the module and its files. Nothing is
deleted in the meantime.

## Part of agent-kit

[agent-kit](https://github.com/DTCurrie/agent-kit) is a portable kit of Claude Code
infrastructure that keeps the agent's context lean. This is one of twelve first-party plugins.
The [package list](https://github.com/DTCurrie/agent-kit#packages) has the rest.

## License

MIT. See [LICENSE](./LICENSE).
