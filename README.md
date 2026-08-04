# agent-kit

A portable kit of Claude Code infrastructure that keeps the agent's context lean.

```
pnpm add -D @agent-kit/cli
pnpm exec agent-kit init
```

This is the workspace root. The product and its full documentation live in
**[packages/cli](packages/cli/README.md)**.

## Packages

| Path                              | Package                             | What it is                                                                            |
| --------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------- |
| `packages/cli`                    | `@agent-kit/cli`                    | The installer and its 15-module core payload. Ships the `agent-kit` binary.           |
| `packages/plugin-prose`           | `@agent-kit/plugin-prose`           | Comment discipline, writing voice, and a token-lean prose output style.               |
| `packages/plugin-testing`         | `@agent-kit/plugin-testing`         | A runner-agnostic testing rule, split into opt-in per-language guides.                |
| `packages/plugin-changesets`      | `@agent-kit/plugin-changesets`      | Changesets integration and the optional per-commit changelog ledger.                  |
| `packages/plugin-backlog`         | `@agent-kit/plugin-backlog`         | An append-only backlog ledger, with the add skill and reviewer agent.                 |
| `packages/plugin-decisions`       | `@agent-kit/plugin-decisions`       | An append-only decision ledger, the `/decide` skill, and the decision-reviewer agent. |
| `packages/plugin-persona-auditor` | `@agent-kit/plugin-persona-auditor` | A blind-rank-then-reconcile persona-auditor agent template.                           |

## Working on the kit

```
pnpm install
pnpm build      # every package
pnpm test
pnpm check
pnpm lint
pnpm dogfood    # wire this repo's .claude/ from every package's payload, so the kit runs itself
```

See [CLAUDE.md](CLAUDE.md) for the working agreement and layout rules.
