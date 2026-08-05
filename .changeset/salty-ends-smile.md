---
'@agent-kit/plugin-prose': minor
'@agent-kit/plugin-testing': minor
'@agent-kit/plugin-changesets': minor
'@agent-kit/plugin-backlog': minor
'@agent-kit/plugin-decisions': minor
'@agent-kit/plugin-persona-auditor': minor
'@agent-kit/plugin-accessibility': minor
'@agent-kit/test': minor
---

Initial release of the seven first-party plugins, six of them split out of the CLI, plus the shared test infrastructure.

Declare a plugin in .claude/kit.config.json under `plugins`, and its modules become selectable as `<alias>/<moduleId>`.

plugin-prose ships code-comments, prose-voice, and output-prose. plugin-testing ships a runner-agnostic testing rule plus opt-in per-language guides. plugin-changesets ships changesets and the per-commit ledger built on it. plugin-accessibility ships a path-scoped WCAG rule for HTML-like markup, opt-in React, Svelte, Vue, and HTML guides, a `wcag.mjs` script that routes a markup change to the criteria it touches, and the 87 WCAG 2.2 success criteria as a pull-only generated reference. plugin-backlog, plugin-decisions, and plugin-persona-auditor ship one module each.

@agent-kit/test ships the synthetic repo builders, a cached post-`init` snapshot via `useInstalledRepo`, CLI and script runners, and installed-tree and doctor-report readers.
