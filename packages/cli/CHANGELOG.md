# @claude-kit/cli

## 0.1.0

Initial release. An interactive installer for a portable Claude Code context-discipline kit.

Detects a repo read-only, previews every file and settings change, then applies. A manifest of
content hashes lets `update` refresh kit-owned files without touching yours, and `doctor`
reports drift or reconciles it with `--fix`.

Ownership splits inside a file as well as between files. The kit maintains a marked region in
CLAUDE.md and owns a rule's body under frontmatter you control. Bytes outside those spans are
never modified.

Ships 15 core modules. Hooks guard destructive git commands, auto-fix changed packages, and
inject session context. Skills cover planning, orchestration, diff-scoped verification, review,
and cleanup.

Plugins extend the kit through `@claude-kit/cli/plugin`. A plugin contributes modules that
return the same declarative actions the built-ins do, and ships its own payload. The six
first-party plugins carry the rules, ledgers, and output style that used to be built in.
