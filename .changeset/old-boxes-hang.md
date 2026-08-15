---
'@houserules/payload': minor
---

Initial release. The shared libraries houserules copies into `.claude/scripts/lib/` and runs on bare node.

Six modules: `config` reads `houserules.config.json` defensively and never throws, `workspaces` enumerates workspace packages, `proc` wraps git and process calls, and `backlog-id`, `entry-ledger`, and `ledger-index` carry the ledger format.

Zero runtime dependencies and node builtins only, because these execute inside a user's repo on every hook. A plugin's payload script imports them by package name, and the `houserules-payload` bin rewrites the specifier to the relative form the flattened `.claude/scripts/` layout needs.
