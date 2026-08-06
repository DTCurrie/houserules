# @agent-kit/plugin-svelte

[![npm](https://img.shields.io/npm/v/@agent-kit/plugin-svelte.svg)](https://www.npmjs.com/package/@agent-kit/plugin-svelte)
[![downloads](https://img.shields.io/npm/dm/@agent-kit/plugin-svelte.svg)](https://www.npmjs.com/package/@agent-kit/plugin-svelte)

An agent trained on older Svelte reaches for `export let`, a `$:` reactive statement, and
`on:click` by reflex, because that is what most of its training data still shows. None of
those fail a Svelte 5 build outright, so they slip into a runes-based codebase as a second,
undocumented convention living next to the first.

This plugin ships the Svelte 5 rule that heads that off, as a rule the agent loads only
when a Svelte file is in the working set.

## Install

```
pnpm add -D @agent-kit/plugin-svelte
pnpm exec agent-kit init
```

Requires [`@agent-kit/cli`](https://github.com/DTCurrie/agent-kit/tree/main/packages/cli).
`init` is what writes the modules into `.claude/`. Both modules below are off by default, so
select them when `init` asks.

## Modules

- **`svelte`** installs `.claude/rules/svelte.md`, a path-scoped rule for Svelte 5 authoring:
  runes throughout (`$state`, `$derived`, `$effect`, `$props`, `$bindable`), component
  structure, context providers, and styling conventions. Never `export let`, never a `$:`
  reactive statement, never `on:click`.

  Scoped to `**/*.svelte`, `**/*.svelte.ts`, and `**/*.svelte.js` through its `paths:`
  frontmatter, so Claude Code loads it only when a matching file is in the working set. Keep
  that frontmatter. A rule file without `paths:` is loaded on every turn.

  Ships an opt-in SvelteKit guide (`sveltekit`), covering routing, load functions, form
  actions, and the server-versus-universal split. It installs alongside the base rule when
  chosen, never on its own, because it opens by assuming `svelte.md` is already installed.

- **`svelte-mcp`** installs the three Svelte MCP server configs (HTTP, stdio, and VS Code)
  under `.claude/mcp/`. The kit never writes `.mcp.json`, so an advise action explains how to
  wire one of them into this repo's own config, and that an unused MCP server costs context on
  every turn.

Doc comments, verification commands, and accessibility are deliberately out of scope of the
`svelte` rule. Those belong to `code-comments.md` and `prose-voice.md` in
[`@agent-kit/plugin-prose`](https://github.com/DTCurrie/agent-kit/tree/main/packages/plugin-prose),
CLAUDE.md's managed region, and `accessibility-svelte.md` in
[`@agent-kit/plugin-accessibility`](https://github.com/DTCurrie/agent-kit/tree/main/packages/plugin-accessibility),
if those rules are installed.

## Part of agent-kit

[agent-kit](https://github.com/DTCurrie/agent-kit) is a portable kit of Claude Code
infrastructure that keeps the agent's context lean. This is one of eleven first-party plugins.
The [package list](https://github.com/DTCurrie/agent-kit#packages) has the rest.

## License

MIT. See [LICENSE](./LICENSE).
