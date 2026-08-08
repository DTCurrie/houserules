# @agent-kit/plugin-design

[![npm](https://img.shields.io/npm/v/@agent-kit/plugin-design.svg)](https://www.npmjs.com/package/@agent-kit/plugin-design)
[![downloads](https://img.shields.io/npm/dm/@agent-kit/plugin-design.svg)](https://www.npmjs.com/package/@agent-kit/plugin-design)

A linter checks syntax and a test checks behavior. Neither knows that the button should have
been `color.brand.primary` rather than a hex value someone typed. So an agent editing UI code
has nothing authoritative to ask what the repo already looks like, and picks a plausible value
instead.

This plugin makes the repo's own design system that authority, and makes it cheap to query by
name rather than by reading the whole token file.

## Install

```
pnpm add -D @agent-kit/plugin-design
pnpm exec agent-kit init
```

Requires [`@agent-kit/cli`](https://github.com/DTCurrie/agent-kit/tree/main/packages/cli).
`init` is what writes the modules into `.claude/`. All three modules are off by default, so
select them when `init` asks.

## Modules

- **`design`** installs four things.

  - **`.claude/design/tokens.json`**, a seeded design system in
    [W3C DTCG format](https://www.designtokens.org/tr/drafts/format/), Design Tokens Format
    Module 2025.10. The kit writes it once and never refreshes it, because the values belong
    to you.
  - **`.claude/rules/design.md`**, a path-scoped rule holding the non-negotiables and a
    routing table.
  - **`.claude/reference/design-visual-principles.md`**, a pull-only reference with the layer
    that holds across design systems: contrast thresholds and the ratio formula, hit-target
    minimums, type scale, spacing rhythm, token coverage. Ships alongside `design-layout.md`
    and `design-performance.md`.
  - **`.claude/scripts/design.mjs`**, the query script.

  Scoped to `**/*.css`, `**/*.jsx`, `**/*.tsx`, `**/*.svelte`, `**/*.vue`, and `**/*.astro`
  through its `paths:` frontmatter. Claude Code loads it only when UI code is in the working
  set. Keep that frontmatter. A rule file without `paths:` is loaded on every turn.

- **`design-review`** installs the `/design-review` skill and a read-only `art-director` agent
  that runs the deterministic checks in `design.mjs` and layers judgment on what they cannot
  compute: exact contrast ratios, the nearest scale value, and which token a hardcoded literal
  should have been. Needs the `design` module for the script and the token set.

- **`design-game`** installs optional pull-only game UI references under
  `.claude/reference/`: HUD and canvas layering, and game visual hierarchy, color, and motion.
  There is deliberately no rule, since whether a repo is a game cannot be detected from a file
  extension.

## Querying the design system

```
node .claude/scripts/design.mjs token color.brand.primary
node .claude/scripts/design.mjs list color
node .claude/scripts/design.mjs scales
```

`token` resolves one token by dot-path, following DTCG alias chains and printing hex for
colors. `list` prints token names, optionally filtered to a group. `scales` prints the spacing,
type, and radius scales as ordered lists.

The token set stays out of context until something asks for a specific value. A design system
inlined into a path-scoped rule is paid on every UI turn for values relevant on almost none of
them, which is why the rule holds a routing table instead of the tokens.

## Replace the seed

The values the kit ships are brand-neutral placeholders, chosen to look obviously generic. A
seed that looks finished never gets edited, and an unedited seed means every design check
measures real code against values nobody chose. `npx agent-kit doctor` warns while the file is
still untouched.

## Relationship to accessibility

`@agent-kit/plugin-accessibility` owns WCAG. This plugin defers to it and does not duplicate
its coverage. Where the two meet is contrast: a foreground and background **token pair** is two
known values, so the ratio is arithmetic, while contrast as actually rendered depends on the
page and stays outside what either plugin settles from source.

## Part of agent-kit

[agent-kit](https://github.com/DTCurrie/agent-kit) is a portable kit of Claude Code
infrastructure that keeps the agent's context lean. This is one of twelve first-party plugins.
The [package list](https://github.com/DTCurrie/agent-kit#packages) has the rest.

## License

MIT. See [LICENSE](./LICENSE).
