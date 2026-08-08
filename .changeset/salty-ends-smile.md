---
'@agent-kit/plugin-prose': minor
'@agent-kit/plugin-testing': minor
'@agent-kit/plugin-changesets': minor
'@agent-kit/plugin-backlog': minor
'@agent-kit/plugin-decisions': minor
'@agent-kit/plugin-persona-auditor': minor
'@agent-kit/plugin-accessibility': minor
'@agent-kit/plugin-typescript': minor
'@agent-kit/plugin-three': minor
'@agent-kit/plugin-svelte': minor
'@agent-kit/plugin-design': minor
'@agent-kit/test': minor
'@agent-kit/plugin-github': minor
'@agent-kit/cli': minor
---

Initial release of the first-party plugins, six of them split out of the CLI, plus the shared test infrastructure.

Declare a plugin in .claude/kit.config.json under `plugins`, and its modules become selectable as `<alias>/<moduleId>`.

plugin-prose ships code-comments, prose-voice, output-prose, and a /pr-description skill that writes the pull request body from the branch diff. plugin-testing ships a runner-agnostic testing rule plus opt-in per-language guides. plugin-changesets ships changesets and the per-commit ledger built on it. plugin-accessibility ships a path-scoped WCAG rule for HTML-like markup, opt-in React, Svelte, Vue, and HTML guides, a `wcag.mjs` script that routes a markup change to the criteria it touches, and the 87 WCAG 2.2 success criteria as a pull-only generated reference. plugin-typescript ships a path-scoped TypeScript rule covering the type-system decisions that have a right answer. plugin-three ships a path-scoped Three.js rule with opt-in Threlte and React Three Fiber guides. plugin-svelte ships a Svelte 5 rule with an opt-in SvelteKit guide, plus a svelte-mcp module carrying the Svelte MCP server configs. plugin-design ships a DTCG design system, a design rule, token extraction, and design review with an art-director agent. plugin-backlog, plugin-decisions, and plugin-persona-auditor ship one module each.

@agent-kit/test ships the synthetic repo builders, a cached post-`init` snapshot via `useInstalledRepo`, CLI and script runners, and installed-tree and doctor-report readers.

plugin-github syncs the backlog and decision ledgers to GitHub Projects. Backlog entries become issues, decisions become draft items, and one project is created per ledger per target. Pushing needs both a local .claude/ledgers/.projects.json that only `bootstrap` writes and maintain or admin on the repository, so no committed file can grant board access. A SessionEnd hook pushes in the background, and the ledger-sync and backlog-adopt skills cover the manual paths.

The ledger directory is now local. The .jsonl was the committed record and is now a gitignored push queue, so `update` untracks it from the index and leaves it on disk. Every push ends by compacting that queue down to what it still owes the board. An entry that reached the board collapses to a single record carrying its issue or item id, an entry removed before it ever reached the board is dropped outright, and an entry with work outstanding is left alone. Without that the ledger grows with the work done rather than the work outstanding. `compact` is a verb of its own as well, needs no network so it works for contributors who cannot push, and keeps the previous ledger beside the new one as .jsonl.bak. `projects.autoSync: false` in kit.config.json forbids syncing repo-wide.
