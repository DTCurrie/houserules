# Phase 1: helpers

**Status:** TODO · **Part of:** [PLAN.md](PLAN.md) · **Roadmap:** [ROADMAP.md](ROADMAP.md)
**Domain:** `src`, `test`

## Objective

Implement two helpers, each in its own stub file. The two steps are independent and their files
are disjoint. Neither edits a test file. Dispatch both steps as one wave of two slices.

Done when `npm test` passes.

## Steps

- [ ] **Step 1: clamp.** Implement `clamp(value, min, max)` in `src/clamp.js`. It returns the
      value limited to the range, and throws a `RangeError` when `min` exceeds `max`.
      Acceptance: `node --test test/clamp.test.js` exits 0.

- [ ] **Step 2: pad.** Implement `padStart(text, width, fill = ' ')` in `src/pad.js`. It fills on
      the left up to `width` characters, leaves longer text unchanged, and throws a `TypeError`
      for an empty `fill`. Acceptance: `node --test test/pad.test.js` exits 0.
