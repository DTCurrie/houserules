# Phase 1: durations

**Status:** TODO · **Part of:** [PLAN.md](PLAN.md) · **Roadmap:** [ROADMAP.md](ROADMAP.md)
**Domain:** `src`, `test`

## Objective

Add three modules, `src/parse/`, `src/format/`, and `src/math/`, over one duration value. Each
step writes the files of one new module only, so the three steps are independent and their
files are disjoint. None edits `src/index.js` or any test file. The existing
`test/clock.test.js` keeps passing after every step.

All three modules build and accept the same value, from `src/duration.js`, which this phase
adds:

- `DurationError`, a subclass of `Error` whose `name` is `DurationError`. Every function in the
  three modules throws it for bad input.
- `makeDuration(ms)` returns a frozen `{ ms }` for a non-negative safe integer and throws a
  `DurationError` for anything else.
- `isDuration(value)` is true only for a value `makeDuration` returned.

`test/duration.test.js` states the cases.

Done when `npm test` and `npm run lint` pass, and every string `formatDuration` prints reads
back through `parseDuration` to a duration of the same `ms`.

## Steps

- [ ] **Step 1: parse.** Add `src/parse/index.js` exporting `parseDuration(text)`.
  - The text is one or more parts written together, such as `1h30m` or `2m5s10ms`. A part is a
    non-negative integer followed by a unit: `h`, `m`, `s`, or `ms`. Parts may come in any
    order, and the result is `makeDuration` of their sum in milliseconds.
  - Throw a `DurationError` for text that is not a string, an empty string, a part with no
    unit or an unknown unit, a number that is not a whole number, or a unit used twice.

  `test/parse.test.js` states the cases. Acceptance: `node --test test/parse.test.js` exits 0.

- [ ] **Step 2: format.** Add `src/format/index.js` exporting `formatDuration(duration)`.
  - Split the duration into days, hours, minutes, seconds, and milliseconds, printed largest
    first as `d`, `h`, `m`, `s`, and `ms`, one space between parts, so `93784005` prints
    `1d 2h 3m 4s 5ms`.
  - Leave out each zero part, and print a zero duration as `0s`.
  - Throw a `DurationError` for anything `isDuration` rejects.

  `test/format.test.js` states the cases. Acceptance: `node --test test/format.test.js` exits
  0.

- [ ] **Step 3: math.** Add `src/math/index.js` exporting four functions, each returning a
      duration from `makeDuration` where it returns one.
  - `addDurations(...durations)` returns their sum, and a zero duration for no arguments.
  - `subtractDuration(a, b)` returns `a` minus `b`, and throws a `DurationError` when `b` is
    longer than `a`.
  - `compareDurations(a, b)` returns `-1`, `0`, or `1`.
  - `scaleDuration(duration, factor)` multiplies by a non-negative finite number and rounds to
    the nearest millisecond. Any other factor throws a `DurationError`.
  - Every argument that should be a duration and is not throws a `DurationError`.

  `test/math.test.js` states the cases. Acceptance: `node --test test/math.test.js` exits 0.
