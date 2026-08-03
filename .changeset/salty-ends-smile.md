---
'@claude-kit/plugin-prose': minor
'@claude-kit/plugin-testing': minor
'@claude-kit/plugin-changesets': minor
'@claude-kit/plugin-backlog': minor
'@claude-kit/plugin-decisions': minor
'@claude-kit/plugin-persona-auditor': minor
---

Initial release of the six first-party plugins split out of the CLI.

Declare one in .claude/kit.config.json under `plugins`, and its modules become selectable as `<alias>/<moduleId>`.

plugin-prose ships code-comments, prose-voice, and output-prose. plugin-testing ships a runner-agnostic testing rule plus opt-in per-language guides. plugin-changesets ships changesets and the per-commit ledger built on it. plugin-backlog, plugin-decisions, and plugin-persona-auditor ship one module each.
