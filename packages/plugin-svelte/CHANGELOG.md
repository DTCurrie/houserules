# @houserules/plugin-svelte

## 0.1.1

### Patch Changes

- 269dd06: Normalize agent frontmatter, scope testing-3d rule to tests, point svelte rule at svelte-lint, add missing script shebangs

## 0.1.0

### Minor Changes

- 359e22c: Initial release. Svelte 5 authoring conventions, an opt-in SvelteKit guide, and the Svelte MCP server config.

  The rule is path-scoped to `.svelte` files and covers runes, the reactivity decisions that differ from Svelte 4, and when `$state.raw` is the right call. Opt into the SvelteKit guide for routing, load functions, and form actions. The separate `svelte-mcp` module ships the MCP server configuration.
