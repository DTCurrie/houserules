# agent-kit

[![npm](https://img.shields.io/npm/v/@agent-kit/cli.svg)](https://www.npmjs.com/package/@agent-kit/cli)
[![downloads](https://img.shields.io/npm/dm/@agent-kit/cli.svg)](https://www.npmjs.com/package/@agent-kit/cli)
[![CI](https://github.com/DTCurrie/agent-kit/actions/workflows/ci.yml/badge.svg)](https://github.com/DTCurrie/agent-kit/actions/workflows/ci.yml)
[![OpenSSF Scorecard](https://api.securityscorecards.dev/projects/github.com/DTCurrie/agent-kit/badge)](https://scorecard.dev/viewer/?uri=github.com/DTCurrie/agent-kit)
[![license](https://img.shields.io/npm/l/@agent-kit/cli.svg)](./LICENSE)
[![node](https://img.shields.io/node/v/@agent-kit/cli.svg)](https://nodejs.org)

A Claude Code session spends most of its budget on context it pays for every turn and on
conclusions it derives twice. agent-kit is a portable kit of infrastructure that pushes that
work off the main agent's context window: into disposable subagents, onto disk as ledgers and
changesets, into deterministic hook scripts, and behind grep-able snapshots.

Install it and run `init` in any repo. It detects what the repo already uses, proposes a set
of modules, previews every write, and then applies them.

## Install

```
pnpm add -D @agent-kit/cli
pnpm exec agent-kit init
```

The package is `@agent-kit/cli` and the binary is `agent-kit`, the same split
`@changesets/cli` uses for `changeset`. Add `--dry-run` to preview without writing, or
`--yes` to skip the prompts.

**[Read the full documentation in `packages/cli`](packages/cli/README.md)**, which covers what
`init` writes, the sixteen built-in modules, drift and updates, and how to write a plugin.

## Packages

| Path                              | Package                             | What it is                                                                              |
| --------------------------------- | ----------------------------------- | --------------------------------------------------------------------------------------- |
| `packages/cli`                    | `@agent-kit/cli`                    | The installer and its 16-module core payload. Ships the `agent-kit` binary.             |
| `packages/plugin-prose`           | `@agent-kit/plugin-prose`           | Comment discipline, writing voice, a prose output style, and the PR-description skill.  |
| `packages/plugin-testing`         | `@agent-kit/plugin-testing`         | A runner-agnostic testing rule, split into opt-in per-language guides.                  |
| `packages/plugin-changesets`      | `@agent-kit/plugin-changesets`      | Changesets integration and the optional per-commit changelog ledger.                    |
| `packages/plugin-backlog`         | `@agent-kit/plugin-backlog`         | An append-only backlog ledger, with the add skill and reviewer agent.                   |
| `packages/plugin-decisions`       | `@agent-kit/plugin-decisions`       | An append-only decision ledger, the `/decide` skill, and the decision-reviewer agent.   |
| `packages/plugin-persona-auditor` | `@agent-kit/plugin-persona-auditor` | A blind-rank-then-reconcile persona-auditor agent template.                             |
| `packages/plugin-accessibility`   | `@agent-kit/plugin-accessibility`   | A WCAG 2.2 rule, framework guides, and a router over changed markup.                    |
| `packages/plugin-typescript`      | `@agent-kit/plugin-typescript`      | A path-scoped TypeScript rule: interface vs type, and `unknown` over `any`.             |
| `packages/plugin-three`           | `@agent-kit/plugin-three`           | Three.js authoring patterns, with opt-in Threlte and React Three Fiber guides.          |
| `packages/plugin-svelte`          | `@agent-kit/plugin-svelte`          | Svelte 5 conventions, an opt-in SvelteKit guide, and the Svelte MCP server config.      |
| `packages/plugin-design`          | `@agent-kit/plugin-design`          | A DTCG design system an agent queries by name, plus the path-scoped design rule.        |
| `packages/test`                   | `@agent-kit/test`                   | Shared testing modules for driving the CLI against synthetic repos. For plugin authors. |

Every package has its own README. Plugins are independent, so install only the ones a repo
needs.

## Requirements

Node 22 or newer. The workspace itself uses pnpm, though the installed kit does not care what
package manager your repo uses.

## Contributing

Setup, the check order, and how to run the kit against itself are in
[CONTRIBUTING.md](CONTRIBUTING.md). Please read the
[Code of Conduct](CODE_OF_CONDUCT.md) first.

To report a security issue, see [SECURITY.md](SECURITY.md). Do not open a public issue for a
vulnerability.

## License

MIT. See [LICENSE](./LICENSE).
