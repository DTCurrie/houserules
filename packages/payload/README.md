# @houserules/payload

The shared libraries that back houserules's installed hooks: reading `houserules.config.json`,
reading and writing the backlog/decision ledgers, listing workspace packages, and running
child processes. Every one of them ships with zero runtime dependencies, node builtins only,
because they are copied byte for byte into a user's `.claude/scripts/lib/` and executed there
on bare node.

This package is not a plugin. It contributes no modules and is never installed directly.
[`@houserules/cli`](https://github.com/DTCurrie/houserules/tree/main/packages/cli)
depends on it directly, copying these libs alongside every hook script that imports one, and any
first-party or third-party plugin that needs one of them imports it by package name:

```ts
import { loadConfigSafe } from '@houserules/payload/config';
```

That import never reaches the published `.mjs`. `@houserules/cli`'s payload build rewrites it to
a relative path pointing at a copy of the lib placed alongside the importing script, which is
what keeps the installed hook dependency-free.

## Part of houserules

[houserules](https://github.com/DTCurrie/houserules) is portable Claude Code
infrastructure that keeps the agent's context lean. The
[package list](https://github.com/DTCurrie/houserules#packages) has the rest.

## License

MIT. See [LICENSE](./LICENSE).
