# @agent-kit/payload

The shared libraries that back agent-kit's installed hooks: reading `kit.config.json`,
reading and writing the backlog/decision ledgers, listing workspace packages, and running
child processes. Every one of them ships with zero runtime dependencies, node builtins only,
because they are copied byte for byte into a user's `.claude/scripts/lib/` and executed there
on bare node.

This package is not a plugin. It contributes no modules and installs nothing on its own.
[`@agent-kit/cli`](https://github.com/DTCurrie/agent-kit/tree/main/packages/cli) depends on it
directly, copying these libs alongside every hook script that imports one, and any first-party
or third-party plugin that needs one of them imports it by package name:

```ts
import { loadConfigSafe } from '@agent-kit/payload/kit-config';
```

That import never reaches the published `.mjs`. `@agent-kit/cli`'s payload build rewrites it to
a relative path pointing at a copy of the lib placed alongside the importing script, which is
what keeps the installed hook dependency-free.

## Part of agent-kit

[agent-kit](https://github.com/DTCurrie/agent-kit) is a portable kit of Claude Code
infrastructure that keeps the agent's context lean. The
[package list](https://github.com/DTCurrie/agent-kit#packages) has the rest.

## License

MIT. See [LICENSE](./LICENSE).
