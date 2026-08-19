# @houserules/plugin-accessibility

## 0.1.0

### Minor Changes

- 62fa341: Initial release. WCAG routing and lookup for agents editing HTML and HTML-like markup.

  A path-scoped rule for markup files, plus opt-in React, Svelte, Vue, and HTML guides. `wcag.mjs` routes a markup change to the success criteria it actually touches, so a diff gets the handful of criteria that apply rather than the whole standard. The 87 WCAG 2.2 success criteria ship as a pull-only generated reference.

  The optional `accessibility-review` module adds an `accessibility-reviewer` agent and the skill that dispatches it.
