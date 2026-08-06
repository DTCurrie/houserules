---
name: design-review
description: Review changed styled markup against the repo's design system, covering design, design system, tokens, spacing and type scales, contrast, hit targets, and component reuse in CSS, JSX, TSX, Svelte, Vue, and Astro. Use before handing off a UI change.
allowed-tools: Bash(git diff:*), Bash(git merge-base:*), Bash(node .claude/scripts/design.mjs:*), Read, Grep, Agent
---

Review the design-system fit of a working-tree change. Arguments (optional file filter): $ARGUMENTS

1. **Resolve the changed UI files.** Diff against the merge-base:
   ```
   git diff --name-only "$(git merge-base HEAD origin/main)"...HEAD
   ```
   Filter to `.css`, `.jsx`, `.tsx`, `.svelte`, `.vue`, `.astro`. If none changed, say so and
   stop. There is nothing to review.
2. **Run the checker.** `node .claude/scripts/design.mjs check <files>` finds hardcoded
   literals, off-scale spacing and type, contrast failures, and undersized hit targets, each
   with an exact number and the token that should replace it.
3. **Read only what it reported.** For a token the check names, run
   `node .claude/scripts/design.mjs token <name>` to confirm it. Never read
   `.claude/design/tokens.json` whole.
4. **Layer judgment for what the script cannot compute:**
   - Whether an existing component is being reinvented. Run
     `node .claude/scripts/design.mjs list [group]` before treating a value as uncovered.
   - Whether a new value needs a new token or an existing one already fits. Reuse is the
     default.
   - Whether visual emphasis lands on the primary action.
   - Calibrate the depth of this to the size of the change. A one-line tweak does not need a
     full critique.
5. **Report in two groups.** Mechanical findings from `design.mjs check` first, each with
   file, line, and the exact token or scale value. Judgment findings second. Do not merge
   the two lists, since they carry different confidence. If nothing is wrong, say so plainly.
   "Nothing to report" is a valid and expected outcome, not a failure to find something. For
   anything that depends on rendered output, say "cannot determine from source" instead of
   guessing.

## Accessibility is a separate review

Contrast and hit-target thresholds are also WCAG success criteria.
`@agent-kit/plugin-accessibility` owns the accessibility verdict. Run its
`/accessibility-review` skill for focus states, keyboard behavior, and screen-reader
concerns. This skill reports the design-system angle only and does not duplicate that work.

## Off-context reviews

For a large diff, run this review through the `art-director` agent instead of in this
context. Hand it the changed files and let it run the checker and read the tokens. Only the
diff and the check output stay in the subagent. The main context gets back a verdict, not a
transcript.

## Findings

Fix anything mechanical the checker named: a literal that maps to an existing token, an
off-scale spacing or type value. For a finding that needs a design decision, such as whether
a new token is warranted, say so and hand it back rather than inventing one.
</content>
