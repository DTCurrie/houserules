---
name: wireit-setup
description: Wire a package's build, check, or test script into wireit, then lint the result. Use when a package.json script needs wireit, caching, or build orchestration, or when adding a wireit block to a package.
allowed-tools: Bash(node .claude/scripts/wireit-lint.mjs:*), Read, Edit
---

Wire one package script into wireit so an unchanged run is skipped. A block that misses an input skips work that should have run, so the steps below declare every input.

The rules are in `.claude/rules/wireit.md`. The checker is `.claude/scripts/wireit-lint.mjs`.

## Steps

1. Read the package's `package.json`. Find the script to wire and read its command.
2. Move the command into a `wireit` block under the script's name, as `command`. Set the script itself to `"wireit"`.
3. List every read class of the command in `files`: sources, configs, tsconfigs, `package.json`, and fixtures. Put `!**/node_modules/**` on any directory glob rooted at or above the package root.
4. Set `output` to the directories the command writes. Use `[]` for a check.
5. Add `dependencies` for each script this one needs first. Name a script in another package as `../<pkg>:<script>`.
6. Run the script twice. The first run executes. The second must report that wireit skipped it. If the second run executes again, an input in `files` changes on every run, so narrow the glob.
7. Run `node .claude/scripts/wireit-lint.mjs <that package.json>` and fix every ERROR. The checker exits 1 on any ERROR.

## Done

The script is `"wireit"`, its block declares `command`, `files`, and `output`, the second run was skipped, and the checker reported no ERROR. Do not call it done on a green first run, because a first run proves nothing about the cache.
