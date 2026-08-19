---
'@houserules/cli': minor
---

Initial release. An interactive installer for a portable Claude Code context-discipline houserules.

`houserules init` detects the repo, plans a set of declarative actions, previews them, and applies. Sixteen built-in modules cover hooks, skills, agents, rules, and reference docs. Ownership is explicit: houserules-owned files are manifest-tracked and refreshed by `update`, seeds belong to you and are never overwritten, and a managed region means houserules writes only between its markers in a file you own.

`houserules doctor` audits an install: config validity, context budget, drift against the manifest, fix and verify script wiring, whether a read-only agent grants an unbounded Bash, and whether every installed reference doc is reachable from something else houserules installed. `--fix` reconciles and `--prune` removes what no enabled module produces.

Plugins extend houserules. Declare one in `.claude/houserules.config.json` under `plugins` and its modules become selectable as `<alias>/<moduleId>`. A plugin codes against `@houserules/api` rather than against this package, so the installer stays out of its dependency graph. `CONVENTIONS.md` documents the contract, including how a plugin's payload reaches a shared lib.

Ships the planning and orchestration skills: `/plan-project` persists a multi-phase plan, `/orchestrate` executes a phase by fanning out scoped implementer subagents, and `/verify-changed`, `/ready`, `/sweep`, and `/blast-radius` cover verification and wide changes.
