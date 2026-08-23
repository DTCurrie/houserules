# @houserules/cli

## 0.4.0

### Minor Changes

- 459999a: Doctor reports path-scoped rule and on-invoke skill and agent prose weight.
- 459999a: plan-lint flags plan-doc file paths that do not exist in the repo.
- 459999a: Doctor scans settings hooks and config for hygiene problems and secret-shaped values.

### Patch Changes

- 459999a: Rendered verification discipline lists recorded completion-claim evasions with answers.
- 459999a: Skill descriptions no longer narrate the skill's internal steps.
- c3268ac: Skills, rules, and rendered CLAUDE.md sections now forbid citing ledger ids in public text.
- Updated dependencies [c3268ac]
  - @houserules/payload@0.2.2
  - @houserules/api@0.3.2

## 0.3.2

### Patch Changes

- d834e38: Orchestrate and ready skills fall back gracefully when no backlog plugin is installed.

## 0.3.1

### Patch Changes

- 0e49523: blast-radius fans out through a dedicated read-only sonnet mapper agent

## 0.3.0

### Minor Changes

- b986353: orchestrate wires optional skills into its lifecycle and gains a context-size gate
- f73b0fc: `houserules report` adds hook, guard, skill, outcome, and friction sections plus repeatable `--slug`.

### Patch Changes

- 67870fc: doctor verifies every installed script's imports resolve

## 0.2.3

### Patch Changes

- 6a5152b: External dependency versions are now managed through the pnpm workspace catalog.
- Updated dependencies [6a5152b]
  - @houserules/api@0.3.1
  - @houserules/payload@0.2.1

## 0.2.2

### Patch Changes

- e11c60f: Merge backups moved to a gitignored .claude/backups/ directory.
- e11c60f: Three.js upstream docs now cover only the chosen framework bindings.
- e11c60f: The ledger directory is only created when a ledger-consuming plugin is installed.
- Updated dependencies [e11c60f]
  - @houserules/api@0.3.0

## 0.2.1

### Patch Changes

- 7b5f72a: Adopt the Jest-standard **tests** directory name for test colocation.

## 0.2.0

### Minor Changes

- cb34f11: reviewers module ships review-package.mjs, packaging a commit range into one reviewable file
- cb34f11: Update refreshes kit-wired hook entries, hookFragment carries if/timeout/async, one merged Bash gate

### Patch Changes

- cb34f11: Drop duplicate payload peerDependencies, dedupe naming clause into code-cleanliness, take clack 1.x
- cb34f11: Share ledger guard helpers from entry-ledger, ending drifting local copies across scripts
- Updated dependencies [cb34f11]
- Updated dependencies [cb34f11]
  - @houserules/payload@0.2.0
  - @houserules/api@0.2.0

## 0.1.2

### Patch Changes

- 269dd06: Fix wireit check inputs so tsconfig and payload-test edits re-run typecheck
- 269dd06: Fix doctor resolution for exports-gated plugins, budget nested skills and output styles, install orchestrate reference files
- Updated dependencies [269dd06]
- Updated dependencies [269dd06]
  - @houserules/payload@0.1.1
  - @houserules/api@0.1.1

## 0.1.1

### Patch Changes

- afc7ff6: Resolve npm-installed plugins whose exports map does not expose `./package.json`.

## 0.1.0

### Minor Changes

- 359e22c: Initial release. An interactive installer for a portable Claude Code context-discipline houserules.

  `houserules init` detects the repo, plans a set of declarative actions, previews them, and applies. Sixteen built-in modules cover hooks, skills, agents, rules, and reference docs. Ownership is explicit: houserules-owned files are manifest-tracked and refreshed by `update`, seeds belong to you and are never overwritten, and a managed region means houserules writes only between its markers in a file you own.

  `houserules doctor` audits an install: config validity, context budget, drift against the manifest, fix and verify script wiring, whether a read-only agent grants an unbounded Bash, and whether every installed reference doc is reachable from something else houserules installed. `--fix` reconciles and `--prune` removes what no enabled module produces.

  Plugins extend houserules. Declare one in `.claude/houserules.config.json` under `plugins` and its modules become selectable as `<alias>/<moduleId>`. A plugin codes against `@houserules/api` rather than against this package, so the installer stays out of its dependency graph. `CONVENTIONS.md` documents the contract, including how a plugin's payload reaches a shared lib.

  Ships the planning and orchestration skills: `/plan-project` persists a multi-phase plan, `/orchestrate` executes a phase by fanning out scoped implementer subagents, and `/verify-changed`, `/ready`, `/sweep`, and `/blast-radius` cover verification and wide changes.

### Patch Changes

- Updated dependencies [359e22c]
- Updated dependencies [359e22c]
  - @houserules/api@0.1.0
  - @houserules/payload@0.1.0

## 0.1.0

Initial release. An interactive installer for a portable Claude Code context-discipline houserules.

Detects a repo read-only, previews every file and settings change, then applies. A manifest of
content hashes lets `update` refresh kit-owned files without touching yours, and `doctor`
reports drift or reconciles it with `--fix`.

Ownership splits inside a file as well as between files. houserules maintains a marked region in
CLAUDE.md and owns a rule's body under frontmatter you control. Bytes outside those spans are
never modified.

Ships 15 core modules. Hooks guard destructive git commands, auto-fix changed packages, and
inject session context. Skills cover planning, orchestration, diff-scoped verification, review,
and cleanup.

Plugins extend houserules through `@houserules/cli/plugin`. A plugin contributes modules that
return the same declarative actions the built-ins do, and ships its own payload. The six
first-party plugins carry the rules, ledgers, and output style that used to be built in.
