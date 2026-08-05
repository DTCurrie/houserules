# @agent-kit/plugin-accessibility

An agent editing markup gets accessibility wrong in predictable ways: a click handler on a
`<div>`, an `<img>` with no `alt` decision, a label that is not associated with its control.
This plugin does not answer that with more prose in always-loaded context. It ships a two-step
lookup the agent can run: **decide which success criteria the change is subject to**, then
**read only those criteria** from a local copy of WCAG 2.2.

Two modules:

- `accessibility`: a path-scoped rule for HTML and HTML-like markup, the 87 WCAG 2.2 success
  criteria as a pull-only reference, and `wcag.mjs`, which routes changed files to the criteria
  in play and looks any of them up. Optional per-framework guides for React, Svelte, Vue, and
  plain HTML or Astro install through the module's options.
- `accessibility-review`: the `/accessibility-review` skill and a read-only
  `accessibility-reviewer` agent that audits a markup diff against the criteria the router
  names.

## The loop

```
node .claude/scripts/wcag.mjs applies src/Button.tsx   # which criteria are in play
node .claude/scripts/wcag.mjs lookup 2.5.8             # read one of them
node .claude/scripts/wcag.mjs patterns                 # the whole routing table
```

`applies` is deliberately over-inclusive. Naming a criterion that turns out not to apply costs
one read. Missing one costs a defect.

## It is not a linter, on purpose

`eslint-plugin-jsx-a11y`, `eslint-plugin-vuejs-accessibility`, and Svelte's own compiler
warnings already do the mechanical checking, and they are better at it than anything shipped
here would be. This plugin owns the routing and the reasoning, and points at those for the rest.
`agent-kit doctor` warns when a repo has a markup framework and no accessibility linter
configured for it.

Nothing here decides contrast ratios, real focus order, or whether alt text is meaningful. Those
need a rendered page or human judgement, and the rule, the skill, and the agent all say so rather
than guessing.

## The reference is pull-only

`.claude/reference/wcag22.md` is roughly 48KB. Grep it for a criterion number or a keyword and
read that window. Never read it whole, and never `@-import` it. The `read-guard` module makes
that mechanical rather than advisory.

The file is generated, not hand-written. `pnpm --filter @agent-kit/plugin-accessibility wcag:regen`
rebuilds it from the W3C source at a pinned tag, and regenerating produces a byte-identical file.

## Credits

`payload/reference/wcag22.md` is derived from
[Web Content Accessibility Guidelines (WCAG) 2.2](https://www.w3.org/TR/WCAG22/), W3C
Recommendation, generated from the `w3c/wcag` repository at tag `WCAG22-20241212`.

Copyright © 2023 W3C®. This software or document includes material copied from or derived from
Web Content Accessibility Guidelines (WCAG) 2.2, https://www.w3.org/TR/WCAG22/.

It is used under the [W3C Document License](https://www.w3.org/copyright/document-license-2023/),
which permits derivative works in supporting materials accompanying software. The MIT license
covering the rest of this package does not cover that file. The full notice is in this package's
`LICENSE`.
