# @agent-kit/plugin-design

An agent-kit plugin that gives an agent editing UI code an authoritative answer to "what does
this repo look like".

A linter checks syntax and a test checks behavior. Neither knows that the button should have
been `color.brand.primary` rather than a hex value someone typed. This plugin makes the repo's
own design system that authority, and makes it cheap to query.

## What it installs

The `design` module ships four things.

- **`.claude/design/tokens.json`**, a design system in
  [W3C DTCG format](https://www.designtokens.org/tr/drafts/format/) (Design Tokens Format
  Module 2025.10). This is a **seed**. The kit writes it once and never refreshes it, because
  the values belong to you.
- **`.claude/rules/design.md`**, a path-scoped rule holding the non-negotiables and a routing
  table. It loads only when UI code is in the working set.
- **`.claude/reference/design-principles.md`**, a pull-only reference with the layer that holds
  across design systems: contrast thresholds and the ratio formula, hit-target minimums, type
  scale, spacing rhythm, token coverage.
- **`.claude/scripts/design.mjs`**, the query script.

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
