---
'@agent-kit/plugin-prose': minor
'@agent-kit/plugin-testing': minor
'@agent-kit/plugin-changesets': minor
'@agent-kit/plugin-backlog': minor
'@agent-kit/plugin-decisions': minor
'@agent-kit/plugin-persona-auditor': minor
---

Initial release of the six first-party plugins split out of the CLI.

Declare one in .claude/kit.config.json under `plugins`, and its modules become selectable as `<alias>/<moduleId>`.

plugin-prose ships code-comments, prose-voice, and output-prose. plugin-testing ships a runner-agnostic testing rule plus opt-in per-language guides. plugin-changesets ships changesets and the per-commit ledger built on it. plugin-backlog, plugin-decisions, and plugin-persona-auditor ship one module each.
