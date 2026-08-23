export type LineKind = 'prose' | 'code' | 'quoted';

const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})/;
const INDENTED_CODE_RE = /^(?: {4}|\t)/;
const BLOCKQUOTE_RE = /^ {0,3}>/;

/**
 * One `LineKind` per line of `markdown`, in `split('\n')` order.
 *
 * Fenced blocks win over everything else once opened, so a line that looks like a
 * blockquote or an indented block inside a fence still reads as `'code'`. An unclosed fence
 * runs `'code'` to end of file, since a reader has no later boundary to trust either.
 */
export function classifyLines(markdown: string): LineKind[] {
  const lines = markdown.split('\n');
  const kinds: LineKind[] = new Array(lines.length);
  let fenceChar: string | null = null;
  let fenceLen = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    if (fenceChar) {
      kinds[i] = 'code';
      const closeRe = new RegExp(`^ {0,3}[${fenceChar}]{${fenceLen},}\\s*$`);
      if (closeRe.test(line)) {
        fenceChar = null;
        fenceLen = 0;
      }
      continue;
    }

    const open = line.match(FENCE_OPEN_RE);
    if (open) {
      kinds[i] = 'code';
      fenceChar = open[1]![0]!;
      fenceLen = open[1]!.length;
      continue;
    }

    if (INDENTED_CODE_RE.test(line) && line.trim().length > 0) {
      kinds[i] = 'code';
      continue;
    }

    if (BLOCKQUOTE_RE.test(line)) {
      kinds[i] = 'quoted';
      continue;
    }

    kinds[i] = 'prose';
  }

  return kinds;
}

/** Replaces every non-newline character in `text` with a space, so line breaks survive. */
function blankKeepingNewlines(text: string): string {
  return text.replace(/[^\n]/g, ' ');
}

/**
 * A backtick run of any length opens an inline span, and only the SAME run length closes
 * it, matching CommonMark's rule and letting `` `` code with a literal backtick `` ``
 * nest safely. `[\s\S]*?` lets the span cross a line break, which is exactly the case the
 * naive same-line regex in `PROBE-regex.md` missed.
 */
const INLINE_SPAN_RE = /(`+)([\s\S]*?)\1/g;

function stripInlineCode(text: string): string {
  return text.replace(INLINE_SPAN_RE, (match) => blankKeepingNewlines(match));
}

/**
 * Returns `markdown` with fenced blocks, indented code blocks, and inline spans replaced by
 * filler of the same length, one line for one line.
 *
 * Line numbers of the surviving prose are unchanged, since a checker built on top reports
 * `file:line` and a stripper that shifts a line number sends the reader to the wrong place.
 * This does NOT strip blockquoted (`'quoted'`) lines. See the module doc for why, and use
 * `classifyLines` to exclude them too if a caller wants that.
 */
export function stripCode(markdown: string): string {
  const lines = markdown.split('\n');
  const kinds = classifyLines(markdown);
  const withCodeBlanked = lines
    .map((line, i) => (kinds[i] === 'code' ? ' '.repeat(line.length) : line))
    .join('\n');
  return stripInlineCode(withCodeBlanked);
}

/**
 * This is the function a prose checker should call. It returns `markdown` reduced to its
 * surviving prose: `stripCode`'s fenced blocks, indented blocks, and inline spans, PLUS
 * blockquoted (`'quoted'`) lines, all replaced by same-length or same-line-count filler.
 * Line numbers are unchanged, same guarantee as `stripCode`.
 *
 * Separates markdown prose from code, so a prose checker never mistakes a code token for a
 * voice violation. A checker built on a naive fence toggle (`` ``` `` flips a boolean, then
 * a same-line backtick regex strips inline spans) measured 0% precision in
 * `PROBE-regex.md`'s b1 candidate: both of its two findings were false positives, one from
 * an inline-code span that opens on one line and closes on the next (the toggle only
 * matched a span with no embedded newline), the other from a blockquoted "before" example
 * that the document quotes on purpose to forbid, not a violation of its own voice. This
 * module fixes the first as a lexing bug and treats the second as a naming decision,
 * documented below.
 *
 * DECISION: a blockquoted line (`^ {0,3}>`) is classified `'quoted'`, never `'prose'`. A
 * checker built on `classifyLines` should skip `'quoted'` lines the same way it skips
 * `'code'` ones. The cost: a genuine callout or admonition written with `>` (not a quoted
 * bad example) also goes unchecked. That trade favors the false negative over the false
 * positive, because `prose-voice.md` itself is the corpus that motivated this fix, and it
 * blockquotes bad examples specifically to forbid them without committing them.
 *
 * Calling `stripCode` alone reintroduces the blockquote false positive this module exists
 * to eliminate: a document that quotes a bad example to forbid it, such as
 * `prose-voice.md`'s own "Punctuation doing work that sentences should do" section, still
 * contains the semicolon `stripCode` leaves behind. Reach for this function unless the
 * caller has a genuine reason to treat blockquoted text as checkable prose, in which case
 * use `classifyLines` and `stripCode` directly and encode that different policy explicitly.
 */
export function stripToProse(markdown: string): string {
  const lines = stripCode(markdown).split('\n');
  const kinds = classifyLines(markdown);
  return lines
    .map((line, i) => (kinds[i] === 'quoted' ? ' '.repeat(line.length) : line))
    .join('\n');
}
