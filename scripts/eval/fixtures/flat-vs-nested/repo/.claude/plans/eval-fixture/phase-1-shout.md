# Phase 1: shout

**Status:** TODO · **Part of:** [PLAN.md](PLAN.md) · **Roadmap:** [ROADMAP.md](ROADMAP.md)
**Domain:** `src/shout.js`

## Objective

Give `shout` options. The step edits `src/shout.js` only. It edits no test file, and
`test/shout.test.js` keeps passing.

Done when `npm test` passes.

## Steps

- [ ] **Step 1: options.** Change `shout(text)` to `shout(text, options)`, editing `src/shout.js`.
  - `bang`: the number of `!` at the end, default 1. `0` gives none, so `shout('hi', { bang: 0 })`
    is `HI`. Anything but a non-negative integer throws a `RangeError`.
  - `repeat`: how many times the upper-cased text appears, joined by single spaces, default 1.
    `shout('go', { repeat: 2 })` is `GO GO!`. Anything but a positive integer throws a
    `RangeError`.
  - Throw a `TypeError` for a text that is not a string, an options value that is not a plain
    object (`null` and arrays included), or an unknown option key.

  `test/shout-options.test.js` states the cases. Acceptance:
  `node --test test/shout-options.test.js` exits 0.
