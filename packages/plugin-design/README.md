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
`init` is what writes the modules into `.claude/`. All four modules are off by default, so
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

- **`design-review`** installs the `/design-review` skill and a read-only `design-reviewer` agent
  that runs the deterministic checks in `design.mjs` and layers judgment on what they cannot
  compute: exact contrast ratios, the nearest scale value, and which token a hardcoded literal
  should have been. Needs the `design` module for the script and the token set.

- **`design-tailwind`** makes the repo's own Tailwind v4 theme the design system
  `design.mjs` queries and audits, in place of the DTCG token seed. No
  `.claude/design/tokens.json` is written. `check` also judges class names, not only CSS
  declarations. It installs a starter `@theme` at
  `.claude/kit-templates/tailwind-theme.css.template` to copy from, and a pull-only
  reference at `.claude/reference/design-tailwind-theming.md` covering how to extend
  Tailwind into a design system and build a theme that switches at runtime. Needs the
  `design` module for the script itself, and is off by default even in a repo that already
  has `tailwindcss`, since the module cannot see whether `design` was also selected. Class-name
  checking additionally needs
  [`@tailwindcss/oxide`](https://www.npmjs.com/package/@tailwindcss/oxide), which is not a
  dependency of `tailwindcss` itself and arrives with `@tailwindcss/vite`,
  `@tailwindcss/postcss`, or the Tailwind CLI. Theme queries work without it. The kit never
  writes into the Tailwind compile path: it reads whatever stylesheet already imports
  Tailwind.

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

### Querying a Tailwind theme

With `design-tailwind` installed, the same commands answer from the repo's compiled Tailwind
theme instead of the token seed, and two more commands ship:

```
node .claude/scripts/design.mjs theme
node .claude/scripts/design.mjs scaffold
node .claude/scripts/design.mjs token color.brand.primary --theme src/app.css
```

`theme` prints the resolved theme, with every entry tagged as the repo's own or one of
Tailwind's defaults. `scaffold` prints a starter semantic layer to stdout and writes
nothing. `--theme <path>` points every query command, including `token`, `list`, `scales`,
and `check`, at the stylesheet Tailwind compiles, for a repo with more than one. See
[`.claude/reference/design-tailwind-theming.md`](https://github.com/DTCurrie/agent-kit/blob/main/packages/plugin-design/payload/reference/design-tailwind-theming.md)
for how to extend the theme and build one that switches at runtime.

## Replace the seed

The values the kit ships are brand-neutral placeholders, chosen to look obviously generic. A
seed that looks finished never gets edited, and an unedited seed means every design check
measures real code against values nobody chose. `npx agent-kit doctor` warns while the file is
still untouched.

This does not apply with `design-tailwind` installed: there is no seed, since the repo's own
Tailwind theme is the source of truth. If a repo adds `design-tailwind` after an earlier
install already wrote `.claude/design/tokens.json`, nothing reads that file anymore. The kit
will not delete it, since a seed is yours to remove, and `npx agent-kit doctor` says so while
it is still there.

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
