# @houserules/plugin-testing

[![npm](https://img.shields.io/npm/v/@houserules/plugin-testing.svg)](https://www.npmjs.com/package/@houserules/plugin-testing)
[![downloads](https://img.shields.io/npm/dm/@houserules/plugin-testing.svg)](https://www.npmjs.com/package/@houserules/plugin-testing)

An agent asked to fix a bug will often write a test that passes before the fix and after it,
which proves nothing. Left alone, it also drifts toward asserting `toBeDefined()`, chasing a
coverage number, or filing a unit test as end-to-end because the distinction was never stated.

This plugin ships a testing discipline rule that does not assume a framework. It covers
whether a test is worth writing, where it lives, what it should assert, and how it is named,
for any runner with a `describe`/`it` shape, plus opt-in guides for the languages that need
suffix and build-exclusion detail the base rule leaves out.

## Install

```
pnpm add -D @houserules/plugin-testing
pnpm exec houserules init
```

Requires [`@houserules/cli`](https://github.com/DTCurrie/houserules/tree/main/packages/cli).
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

- **`playwright-mcp`** installs the Playwright MCP server config under `.claude/mcp/`, as
  `playwright.stdio.json` and `playwright.vscode.json`. houserules never writes `.mcp.json`, so an
  advise action explains how to wire one of them into this repo's own config. Reach for it for
  cross-browser work and test assertions. For performance traces, Lighthouse, and heap snapshots,
  `chrome-devtools-mcp` in `@houserules/plugin-design` is the pick, and the advise text in both
  modules says so.

  The default surface is 24 tool definitions, paid on every turn whether you use them or not, and
  the shipped `--caps=testing` brings it to 29. Every other capability is opt-in through `--caps`.
  The args pin `@playwright/mcp@0.0.79`, because the package is pre-1.0 and `@latest` could change
  the tool surface without warning, and they carry `--headless` and `--isolated`. Switching
  browsers is a one-word edit: `--browser firefox`, `--browser webkit`, or `--browser msedge`.

## Upgrading from the CLI core

`testing` was a built-in CLI module. A repo that recorded it before the split gets a
`HouseError` on its next `init` or `update` naming this package. Installing it and adding it to
the `plugins` array in `.claude/houserules.config.json` restores the module and its files. Nothing is
deleted in the meantime.

## Part of houserules

[houserules](https://github.com/DTCurrie/houserules) is a portable set of Claude Code
infrastructure that keeps the agent's context lean. This is one of twelve first-party plugins.
The [package list](https://github.com/DTCurrie/houserules#packages) has the rest.

## License

MIT. See [LICENSE](./LICENSE).
