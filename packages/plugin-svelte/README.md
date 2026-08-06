# @agent-kit/plugin-svelte

An agent-kit plugin contributing two modules:

- `svelte`: a path-scoped rule for Svelte 5 authoring: runes throughout (`$state`,
  `$derived`, `$effect`, `$props`, `$bindable`), component structure, context providers, and
  styling conventions. Never `export let`, never a `$:` reactive statement, never
  `on:click`. Scoped to `**/*.svelte`, `**/*.svelte.ts`, and `**/*.svelte.js`, so it loads
  only when a matching file is in the working set. Ships an opt-in SvelteKit guide
  (`sveltekit`) covering routing, load functions, form actions, and the server-versus-
  universal split, installed alongside the base rule when chosen.
- `svelte-mcp`: installs the three Svelte MCP server configs (HTTP, stdio, and VS Code)
  under `.claude/mcp/`. The kit never writes `.mcp.json`, so an advise action explains how
  to wire one of them into this repo's own config, and that an unused MCP server costs
  context on every turn.

Both modules are off by default. Doc comments, verification commands, and accessibility are
deliberately out of scope of the `svelte` rule: those are `code-comments.md`,
CLAUDE.md's managed region, and `accessibility-svelte.md`'s jobs if those rules are
installed.
