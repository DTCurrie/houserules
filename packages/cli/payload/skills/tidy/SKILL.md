---
name: tidy
description: Tidy and clean up the working diff by auditing it against the code-cleanliness rule: fix mechanical violations in naming, function size, magic values, and dead code. Use after writing or changing code. For general simplification and reuse cleanups, use `simplify` instead.
allowed-tools: Read, Edit, Grep, Glob, Bash
---

Audit the current working diff against the kit's installed `code-cleanliness` rule and fix the
mechanical violations it finds. This is rule-driven, not judgment-driven. Every finding cites the
clause it violates. It is narrower than `simplify`, which handles reuse, efficiency, and altitude.

## 1. Scope

```
git diff --name-only
```

Reviewing a branch rather than just the working tree? Use `git diff --name-only <base>...HEAD`.
Limit the audit to the changed files and the changed hunks inside them. Never sweep the whole
repo. A repo-wide mechanical pass is `/sweep`, not this skill.

## 2. Read the rule

Load `.claude/rules/code-cleanliness.md`. If it is not installed, say so and stop. Do not fall
back to a general cleanliness pass on your own judgment, because that is `simplify` with extra
steps. This skill has no opinion of its own, only the rule's.

## 3. Audit

Walk each changed hunk against the rule's sections: Naming, Function size, Magic values, and Dead
and speculative code. For each finding, record the file, the line, the specific clause it
violates, and the fix. A finding with no matching clause is not a finding, it is an opinion, and
this skill does not report opinions.

Skip anything the rule scopes elsewhere, such as formatting, import order, comments, or
design-level duplication. Those belong to the repo's linter, `code-comments.md`, and
`design-principles.md`, not this audit.

## 4. Apply

Fix the mechanical findings directly: local renames, extracted constants, deleted dead code, and
early returns. Do not touch anything outside the Naming, Function size, Magic values, and Dead
code sections. Performance, architecture, and reuse findings are out of scope here. Leave those
for `simplify` and `/review-change`.

The one correctness risk is renaming an exported symbol. A textual rename can miss a caller and
silently break it. Check for `.claude/scripts/rename.mjs`:

- If it is installed, run the exported-symbol rename through it rather than editing text by hand.
- If it is not installed, do not perform the rename. Propose it in the report instead, with the
  old name, the new name, and the file.

Local variable and parameter renames carry no such risk. Apply those directly.

## 5. Report

List what was fixed, each with the clause it violated. Then list what was deliberately left
alone, each with the reason, such as a 40-line function that genuinely needs the length. Silent
non-action reads as clean, so name it instead. Finally list any proposed exported-symbol renames
that need the `rename` module, or ran through it if installed.

Keep the report to findings and dispositions, not a restated diff. A reader wants to know what
changed and why, not to re-derive it from a wall of before-and-after code.
