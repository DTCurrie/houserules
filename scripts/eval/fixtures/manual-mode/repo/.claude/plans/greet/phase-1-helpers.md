# Phase 1: helpers

**Status:** TODO · **Part of:** [PLAN.md](PLAN.md) · **Roadmap:** [ROADMAP.md](ROADMAP.md)
**Domain:** `src`, `test`

## Objective

Implement two helpers, each in its own stub file. The two steps are independent and their files
are disjoint. Neither edits a test file.

Done when `npm test` passes.

## Steps

- [ ] **Step 1: shout.** Implement `shout(text)` in `src/shout.js`. It returns the text in upper
      case with `!` appended. Acceptance: `node --test test/shout.test.js` exits 0.

- [ ] **Step 2: whisper.** Implement `whisper(text)` in `src/whisper.js`. It returns the text in
      lower case with `...` appended. Acceptance: `node --test test/whisper.test.js` exits 0.
