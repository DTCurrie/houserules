# Phase 1: helpers

**Status:** TODO · **Part of:** [PLAN.md](PLAN.md) · **Roadmap:** [ROADMAP.md](ROADMAP.md)
**Domain:** `src`, `test`

## Objective

Implement six helpers, each in its own stub file. The six steps are independent and their files
are disjoint. No step edits a test file.

Done when `npm test` passes.

## Steps

- [ ] **Step 1: shout.** Implement `shout(text)` in `src/shout.js`. It returns the text in upper
      case with `!` appended. Acceptance: `node --test test/shout.test.js` exits 0.

- [ ] **Step 2: whisper.** Implement `whisper(text)` in `src/whisper.js`. It returns the text in
      lower case with `...` appended. Acceptance: `node --test test/whisper.test.js` exits 0.

- [ ] **Step 3: reverse.** Implement `reverse(text)` in `src/reverse.js`. It returns the text with
      its characters in reverse order. Acceptance: `node --test test/reverse.test.js` exits 0.

- [ ] **Step 4: title.** Implement `title(text)` in `src/title.js`. It returns the text with the
      first letter of each space-separated word in upper case and the rest in lower case.
      Acceptance: `node --test test/title.test.js` exits 0.

- [ ] **Step 5: dash.** Implement `dash(text)` in `src/dash.js`. It returns the text in lower case
      with each run of spaces replaced by one `-`. Acceptance: `node --test test/dash.test.js`
      exits 0.

- [ ] **Step 6: count.** Implement `count(text)` in `src/count.js`. It returns the number of
      space-separated words, ignoring extra spaces. Acceptance: `node --test test/count.test.js`
      exits 0.
