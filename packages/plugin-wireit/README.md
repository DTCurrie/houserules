# @houserules/plugin-wireit

[![npm](https://img.shields.io/npm/v/@houserules/plugin-wireit.svg)](https://www.npmjs.com/package/@houserules/plugin-wireit)

A wireit block that misses a real input does not fail. It skips work that should have run, and
the agent reads the skip as a pass. An agent also tends to start every package's test pool at
once, because wireit fans out to twice the cores by default.

This plugin ships the wireit rule, a checker over every `wireit` block, and a setup skill, so a
cache hit means what the agent thinks it means.

## Install

```
pnpm add -D @houserules/plugin-wireit
pnpm exec houserules init
```

Requires [`@houserules/cli`](https://github.com/DTCurrie/houserules/tree/main/packages/cli).
`init` is what writes the modules into `.claude/`. All three modules are off by default, so
select them when `init` asks.

## Modules

- **`wireit`** installs `.claude/rules/wireit.md`, a path-scoped rule covering what a block
  declares, how to run it, and what a cache hit proves. It is scoped to `**/package.json`
  through its `paths:` frontmatter, so it costs nothing on the always-loaded surface. Keep that
  frontmatter. A rule file without `paths:` is loaded on every turn.

  It also writes `.claude/extensions/wireit.json`, the fragment the core scripts read:

  ```json
  {
    "shareVariables": ["WIREIT_PARALLEL"],
    "manifestIgnoreKeys": ["wireit"]
  }
  ```

  `verify-changed` sets each `shareVariables` entry to a job's share of the script budget, so
  wireit's own fan-out stays inside it. The changeset gate skips a `package.json` whose only
  diff sits under a `manifestIgnoreKeys` key, since a wireit block never changes what a consumer
  of the published tarball observes.

- **`wireit-lint`** installs `.claude/scripts/wireit-lint.mjs` and its permission. It flags a
  `"wireit"` script with no block, a block with no script, a directory glob with no
  `node_modules` exclusion, a block with a `command` and no `files`, a block with no `output`,
  and a dependency naming a missing script.

- **`wireit-setup`** installs `/wireit-setup`, a skill that wires one package script into
  wireit and then runs `wireit-lint` over it. It requires `wireit-lint`.

## What it leaves alone

Whether `files` covers every input a script reads is a human read. No checker can see a file a
script opens at runtime.

Prose quality is out of scope. Sentences inside comments belong to `prose-voice.md` in
[`@houserules/plugin-prose`](https://github.com/DTCurrie/houserules/tree/main/packages/plugin-prose),
which the `wireit` module lists as a related module.

## Part of houserules

[houserules](https://github.com/DTCurrie/houserules) is a portable set of Claude Code
infrastructure that keeps the agent's context lean. This is one of thirteen first-party plugins.
The [package list](https://github.com/DTCurrie/houserules#packages) has the rest.

## License

MIT. See [LICENSE](./LICENSE).
