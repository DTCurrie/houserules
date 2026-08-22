# @houserules/plugin-accessibility

## 0.1.3

### Patch Changes

- 6a5152b: External dependency versions are now managed through the pnpm workspace catalog.

## 0.1.2

### Patch Changes

- cb34f11: Drop duplicate payload peerDependencies, dedupe naming clause into code-cleanliness, take clack 1.x

## 0.1.1

### Patch Changes

- 269dd06: Fix wireit check inputs so tsconfig and payload-test edits re-run typecheck

## 0.1.0

### Minor Changes

- 359e22c: Initial release. WCAG routing and lookup for agents editing HTML and HTML-like markup.

  A path-scoped rule for markup files, plus opt-in React, Svelte, Vue, and HTML guides. `wcag.mjs` routes a markup change to the success criteria it actually touches, so a diff gets the handful of criteria that apply rather than the whole standard. The 87 WCAG 2.2 success criteria ship as a pull-only generated reference.

  The optional `accessibility-review` module adds an `accessibility-reviewer` agent and the skill that dispatches it.
