---
name: accessibility-review
description: Review changed markup for accessibility against WCAG 2.2, covering a11y, contrast, screen reader, keyboard, and focus behavior in HTML, JSX, TSX, Svelte, Vue, and Astro. Use before handing off a change that touches markup.
allowed-tools: Bash(git diff:*), Bash(git merge-base:*), Bash(node .claude/scripts/wcag.mjs:*), Read, Grep, Agent
---

Review the accessibility of a working-tree change. Arguments (optional file filter): $ARGUMENTS

1. **Resolve the changed markup files.** Diff against the merge-base:
   ```
   git diff --name-only "$(git merge-base HEAD origin/main)"...HEAD
   ```
   Filter to `.html`, `.jsx`, `.tsx`, `.svelte`, `.vue`, `.astro`. If none changed, say so and
   stop. There is nothing to review.
2. **Route the files.** Run the router over the changed markup:
   ```
   node .claude/scripts/wcag.mjs applies <files>
   ```
   It prints the patterns that fired and the criteria in play. It is deliberately
   over-inclusive: it names candidates, it does not judge whether the markup satisfies them.
3. **Read only the criteria the router named.** Grep `.claude/reference/wcag22.md` for each
   criterion number and read that window. Never read the file whole. It is roughly 800 lines
   and grepping the named criteria is the entire point of the router.
4. **Check the changed markup against each named criterion**, plus the rule in
   `accessibility.md` (native elements over ARIA, accessible names, keyboard, focus, forms,
   color, structure).
5. **Run the repo's own accessibility linter if one exists** (eslint-plugin-jsx-a11y,
   axe, svelte-check a11y rules, or similar) and reconcile its output with your review. The
   linter owns mechanical findings such as a missing `alt` or a missing label. This skill
   owns the findings that need judgement, such as whether an accessible name matches its
   visible label or whether a focus move after a route change makes sense.
6. **Report per criterion.** For each criterion in play, state whether the change satisfies
   it, violates it, or cannot be determined from source. Separate the three groups instead of
   giving one pass/fail verdict.

## Contrast, focus order, and alt text cannot be settled from source

Color contrast ratios, real tab and focus order, and whether alt text is meaningful all
depend on rendered output or human judgement, not on markup alone. Never guess these from
source. Flag them for a human reviewer or a rendered/browser check, and say plainly in the
report that they were not verified.

## Off-context reviews

For a large diff, run this review through the `accessibility-reviewer` agent instead of
in this context. Hand it the changed files and let it do the diffing, routing, and
criterion reading. Only the diff and the criteria stay in the subagent. The main context
gets back a verdict, not a transcript.

## Findings

Fix anything mechanical: a missing label, a missing landmark, a positive `tabindex`, an
`alt` left off entirely. For anything that needs a product decision, such as what a
decorative image's `alt` text should say or where focus should land after a modal closes,
say so and hand it back rather than inventing an answer.
