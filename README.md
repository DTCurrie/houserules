# houserules

[![npm](https://img.shields.io/npm/v/@houserules/cli.svg)](https://www.npmjs.com/package/@houserules/cli)
[![CI](https://github.com/DTCurrie/houserules/actions/workflows/ci.yml/badge.svg)](https://github.com/DTCurrie/houserules/actions/workflows/ci.yml)
[![OpenSSF Scorecard](https://api.securityscorecards.dev/projects/github.com/DTCurrie/houserules/badge)](https://scorecard.dev/viewer/?uri=github.com/DTCurrie/houserules)
[![node](https://img.shields.io/node/v/@houserules/cli.svg)](https://nodejs.org)

> [!WARNING]
> This package is still a work-in-progress and every API should be considered experimental and likely to break. There will be no guarantee of backward compatibility until version 1.0.0. Use at your own risk.

A Claude Code session spends most of its budget on context it pays for every turn and on
conclusions it derives twice. `houserules` pushes that work off the main agent's context window:
into disposable subagents, onto disk as ledgers and changesets, into deterministic hook scripts,
and behind grep-able snapshots.

As the name implies, your chosen language and framework ship a "rulebook". House rules are the
conventions your "table" actually plays by, layered on top. This installs them, in a form the
agent reads every turn.

Install it and run `init` in any repo. It detects what the repo already uses, proposes a set
of modules, previews every write, and then applies them.

## Install

```
pnpm add -D @houserules/cli
pnpm exec houserules init
```

The package is `@houserules/cli` and the binary is `houserules`, the same split
`@changesets/cli` uses for `changeset`. Add `--dry-run` to preview without writing, or
`--yes` to skip the prompts.

**[Read the full documentation in `packages/cli`](packages/cli/README.md)**, which covers what
`init` writes, the sixteen built-in modules, drift and updates, and how to write a plugin.

## Packages

| Path                              | Package                              | What it is                                                                                                                           |
| --------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/cli`                    | `@houserules/cli`                    | The installer and its 16-module core payload. Ships the `houserules` binary.                                                         |
| `packages/payload`                | `@houserules/payload`                | The shared payload libs (`config`, `entry-ledger`, and friends), zero dependencies.                                                  |
| `packages/api`                    | `@houserules/api`                    | The plugin API package: action types, module definitions, and the `houserules.config.json` schema that plugin authors build against. |
| `packages/plugin-prose`           | `@houserules/plugin-prose`           | Comment discipline, writing voice, a prose output style, and the PR-description skill.                                               |
| `packages/plugin-testing`         | `@houserules/plugin-testing`         | A runner-agnostic testing rule, split into opt-in per-language guides.                                                               |
| `packages/plugin-changesets`      | `@houserules/plugin-changesets`      | Changesets integration and the optional per-commit changelog ledger.                                                                 |
| `packages/plugin-backlog`         | `@houserules/plugin-backlog`         | An append-only backlog ledger, with the add skill and reviewer agent.                                                                |
| `packages/plugin-decisions`       | `@houserules/plugin-decisions`       | An append-only decision ledger, the `/decide` skill, and the decision-reviewer agent.                                                |
| `packages/plugin-persona-auditor` | `@houserules/plugin-persona-auditor` | A blind-rank-then-reconcile persona-auditor agent template.                                                                          |
| `packages/plugin-accessibility`   | `@houserules/plugin-accessibility`   | A WCAG 2.2 rule, framework guides, and a router over changed markup.                                                                 |
| `packages/plugin-typescript`      | `@houserules/plugin-typescript`      | A path-scoped TypeScript rule: interface vs type, and `unknown` over `any`.                                                          |
| `packages/plugin-three`           | `@houserules/plugin-three`           | Three.js authoring patterns, with opt-in Threlte and React Three Fiber guides.                                                       |
| `packages/plugin-svelte`          | `@houserules/plugin-svelte`          | Svelte 5 conventions, an opt-in SvelteKit guide, and the Svelte MCP server config.                                                   |
| `packages/plugin-design`          | `@houserules/plugin-design`          | A DTCG design system an agent queries by name, or `design-tailwind` for a Tailwind repo.                                             |
| `packages/plugin-github`          | `@houserules/plugin-github`          | Syncs the backlog and decision ledgers to GitHub Projects, with adopt and sync skills.                                               |
| `packages/test`                   | `@houserules/test`                   | Shared testing modules for driving the CLI against synthetic repos. For plugin authors.                                              |

Every package has its own README. Plugins are independent, so install only the ones a repo
needs.

## Requirements

Node 22 or newer. The workspace itself uses pnpm, though what it installs does not care what
package manager your repo uses.

## Contributing

Setup, the check order, and how to run houserules against itself are in
[CONTRIBUTING.md](CONTRIBUTING.md). Please read the
[Code of Conduct](CODE_OF_CONDUCT.md) first.

To report a security issue, see [SECURITY.md](SECURITY.md). Do not open a public issue for a
vulnerability.

## License

MIT. See [LICENSE](./LICENSE).
