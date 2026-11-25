# Phase 2: helpers

**Status:** TODO · **Part of:** [PLAN.md](PLAN.md) · **Roadmap:** [ROADMAP.md](ROADMAP.md)
**Domain:** `src/text`, `src/range`, `src/layout`

## Objective

Extend the package's three existing modules, `src/text/`, `src/range/`, and `src/layout/`.
Each step edits the files of one module only, so the three steps are independent and their
files are disjoint. None edits `src/index.js` or any test file. The current-behavior tests,
`test/text.test.js`, `test/range.test.js`, and `test/layout.test.js`, keep passing after
every step.

Done when `npm test` passes.

## Steps

- [ ] **Step 1: slugify.** Add a slug format to `src/text/`, editing four existing files.
  - `tokenize.js`: `tokenize(text)` becomes `tokenize(text, options)`. `foldAccents` decomposes
    the text and drops its combining marks before splitting, so `Crème` gives `Creme`.
    `splitCamel` splits each run at its case boundaries, so `parseHTTPResponse` gives `parse`,
    `HTTP`, `Response`. Both default to false. Throw a `TypeError` for null or undefined text,
    an options value that is not an object, an unknown option key, or a non-boolean option.
  - `normalize.js`: `normalize(tokens)` becomes `normalize(tokens, options)`. `stopWords`, an
    array of ASCII letter-and-digit words, drops each word token matching one after
    lower-casing, unless every token would go, in which case none is dropped. A `stopWords`
    that is not an array, or holds anything but such a word, throws a `TypeError`.
  - `format.js`: add `formatSlug(tokens, { separator, maxLength })`. `separator` is `-`
    (default), `_`, or `.`, and anything else throws a `TypeError`. `maxLength` keeps whole
    tokens while the slug fits, and when the first token alone is too long, cuts it to
    `maxLength`; anything but a positive integer throws a `RangeError`. `formatSnake` shares
    the joining logic.
  - `index.js`: `titleCase` and `snakeCase` take an `options` argument passed through to
    `tokenize`. Add `slugify(text, { separator, maxLength, stopWords })`, which tokenizes with
    both `foldAccents` and `splitCamel` on, normalizes with `stopWords`, and formats the slug.

  `test/slugify.test.js` states the cases. Acceptance: `node --test test/slugify.test.js`
  exits 0.

- [ ] **Step 2: clamp.** Add clamping with excluded and open bounds to `src/range/`, editing
      four existing files. A parsed range gains `minExclusive` and `maxExclusive` booleans.
  - `parse.js`: `parseRange` reads two new string forms. An interval such as `"[0, 10)"` uses
    `[` and `]` to include a bound and `(` and `)` to exclude it. A dotted range may leave
    one side out, `"0.."` or `"..5"`, giving `Infinity` or `-Infinity` there; `".."` alone is
    a `SyntaxError`. A pair parses with both flags false, and an object passes its own
    `minExclusive` and `maxExclusive`, defaulting to false.
  - `validate.js`: `validateRange` throws a `TypeError` for a flag that is not a boolean, and
    a `RangeError` for a range holding no value: an `Infinity` min, a `-Infinity` max, or
    equal bounds with either excluded. Add `validateStep(step)`, which returns `undefined`
    for no step and throws a `RangeError` for anything but a positive finite number.
  - `bounds.js`: `contains` honors the flags. Add `clampTo(range, value, step)`. A value
    inside the range comes back unchanged. Without a step, a value outside comes back as the
    nearest bound, and clamping to an excluded bound throws a `RangeError`. With a step, a
    value outside comes back as the nearest multiple of the step inside the range, and a
    range holding no multiple throws a `RangeError`. A value that is not a number, `NaN`
    included, throws a `TypeError`.
  - `index.js`: add `clamp(value, spec, { step })`, which validates the range and the step and
    calls `clampTo`. `range` returns the four-field range.

  `test/clamp.test.js` states the cases. Acceptance: `node --test test/clamp.test.js` exits 0.

- [ ] **Step 3: pad.** Add column-aware padding to `src/layout/`, editing four existing files.
  - `width.js`: `displayWidth` counts columns, not code points: 0 for a combining mark or a
    zero-width character, 2 for an East Asian wide or fullwidth character or an emoji, and 1
    otherwise. Export the per-character `charWidth`. Add `sliceToWidth(text, columns)`, the
    longest start of the text that fits, leaving out a wide character that would straddle
    the last column.
  - `fill.js`: `repeatFill(fill, count)` counts columns. A wide fill character that would
    straddle the last column becomes a space, so the result is exactly `count` columns. A
    fill of zero width, the empty string included, throws a `TypeError`.
  - `align.js`: `alignLeft`, `alignRight`, and `alignCenter` take `(text, width, options)`
    with `{ fill, truncate, ellipsis }` in place of the positional `fill`. Add
    `fitText(text, width, options)`: with `truncate`, text wider than `width` is cut to fit
    and ends with `ellipsis` (default `…`), or is cut bare when the ellipsis alone is wider
    than `width`.
  - `index.js`: `align` keeps its signature and passes `{ fill }` to the new alignments. Add
    `pad(text, width, { side, fill, truncate, ellipsis })`, where `side` is `start` (default,
    fill before the text), `end`, or `both` (centered). A width that is not a non-negative
    integer throws a `RangeError`, and any other `side` throws a `TypeError`.

  `test/pad.test.js` states the cases. Acceptance: `node --test test/pad.test.js` exits 0.
