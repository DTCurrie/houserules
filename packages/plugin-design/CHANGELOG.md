# @houserules/plugin-design

## 0.1.0

### Minor Changes

- 359e22c: Initial release. A DTCG design system an agent can query, plus the rule that points at it.

  `design.mjs` reads a DTCG token document and answers questions about it: what a token resolves to, whether a pair meets contrast, and whether a value is on the scale. `extract` bootstraps a first draft from existing code. Both the declared-pair and rendered-page checks measure through one parser, so the two tiers report the same ratio for the same colors.

  Optional modules: `design-review` adds a `design-reviewer` agent and its skill, `design-tailwind` wraps the host's own Tailwind rather than reimplementing it, `design-game` adds HUD and visual guides, and `chrome-devtools-mcp` ships the Chrome DevTools MCP server config as a full 29-tool or slim 3-tool variant, with a `/chrome-devtools-mode` skill that switches a wired-in config between them. An optional module installs its reference doc only when the design rule that links it is also installed, so nothing ships unreachable.
