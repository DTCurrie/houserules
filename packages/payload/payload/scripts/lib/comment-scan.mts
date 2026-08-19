/**
 * A single comment found in JS/TS source.
 *
 * `text` is the raw source slice including its delimiters (`//`, `/* ... *\/`), so a caller
 * can inspect the exact bytes rather than a re-derived body.
 */
export interface Comment {
  text: string;
  /** 1-indexed line the comment starts on. */
  line: number;
  kind: 'line' | 'block' | 'tsdoc';
}

type Frame =
  { kind: 'template' } | { kind: 'interpolation'; braceDepth: number };

/**
 * Keywords after which a following `/` starts an expression, so it is a regex, not division.
 * `return x /y/.test(z)/2` is legal but rare, and this list favors the common case.
 */
const REGEX_ALLOWED_AFTER = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'yield',
  'case',
  'do',
  'else',
  'throw',
  'await',
]);

const IDENTIFIER_START = /[A-Za-z_$]/;
const IDENTIFIER_PART = /[A-Za-z0-9_$]/;
const DIGIT = /[0-9]/;
const NUMBER_PART = /[0-9.eExXa-fA-FoObB_]/;

function classifyBlock(raw: string): 'block' | 'tsdoc' {
  if (raw === '/**/') return 'block';
  if (!raw.startsWith('/**')) return 'block';
  if (raw.startsWith('/***')) return 'block';
  return 'tsdoc';
}

/**
 * Scans a JS/TS regex literal starting at the opening `/` and returns the index past its
 * closing delimiter and flags, or null when it cannot be a valid regex literal (an
 * unterminated one, since JS regex literals cannot span a line).
 */
function scanRegexLiteral(source: string, start: number): number | null {
  let i = start + 1;
  let inClass = false;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '\n') return null;
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === '[') {
      inClass = true;
      i++;
      continue;
    }
    if (ch === ']') {
      inClass = false;
      i++;
      continue;
    }
    if (ch === '/' && !inClass) {
      i++;
      while (i < source.length && /[a-zA-Z]/.test(source[i]!)) i++;
      return i;
    }
    i++;
  }
  return null;
}

/**
 * Extracts every `//` and `/* *\/` comment from JS/TS source, without misreading comment-like
 * text inside string literals, template literals (including `${}` interpolation), or regex
 * literals as a real comment.
 *
 * Regex-versus-division is genuinely ambiguous without a full parser: `/` can open a regex
 * literal or mean division, and the two read identically until more context resolves them.
 * This uses the standard last-significant-token heuristic (regex is allowed right after an
 * operator, `(`, `,`, `;`, `{`, `}`, `[`, or a keyword like `return`, and disallowed right
 * after an identifier, a number, `)`, or `]`), which is what most parser-free JS tokenizers
 * use and correctly handles `/https:\/\//`. It can still misjudge pathological input such as
 * `a\n/re/g` split oddly, or division immediately after a keyword also used as an identifier.
 * On the ambiguous side this favors treating `/` as a regex start, since misreading a regex's
 * body as code risks reading its own `//` as a comment (a false comment finding), while
 * misreading division as a regex start only swallows code until the next unescaped `/` or
 * the end of the line, which cannot itself invent a comment.
 */
export function scanComments(source: string): Comment[] {
  const comments: Comment[] = [];
  const frames: Frame[] = [];
  let line = 1;
  let prevAllowsRegex = true;
  let i = 0;

  const advance = () => {
    if (source[i] === '\n') line++;
    i++;
  };

  /**
   * Consumes a single or double quoted string, including its closing quote.
   *
   * Split out of the main scan loop so the escape branch does not push the loop past four
   * levels of nesting. A backslash consumes the next character whatever it is, which is what
   * keeps an escaped quote from ending the string early.
   */
  const skipQuoted = (quote: string): void => {
    advance();
    while (i < source.length && source[i] !== quote) {
      if (source[i] === '\\') {
        advance();
        if (i < source.length) advance();
        continue;
      }
      advance();
    }
    if (i < source.length) advance();
  };

  while (i < source.length) {
    const top = frames[frames.length - 1];

    if (top?.kind === 'template') {
      const ch = source[i];
      if (ch === '\\') {
        advance();
        if (i < source.length) advance();
        continue;
      }
      if (ch === '`') {
        frames.pop();
        advance();
        prevAllowsRegex = false;
        continue;
      }
      if (ch === '$' && source[i + 1] === '{') {
        frames.push({ kind: 'interpolation', braceDepth: 0 });
        advance();
        advance();
        prevAllowsRegex = true;
        continue;
      }
      advance();
      continue;
    }

    const ch = source[i];
    const next = source[i + 1];

    if (ch === '/' && next === '/') {
      const start = line;
      let end = i + 2;
      while (end < source.length && source[end] !== '\n') end++;
      comments.push({ text: source.slice(i, end), line: start, kind: 'line' });
      i = end;
      continue;
    }

    if (ch === '/' && next === '*') {
      const start = line;
      let end = i + 2;
      while (
        end < source.length &&
        !(source[end] === '*' && source[end + 1] === '/')
      ) {
        if (source[end] === '\n') line++;
        end++;
      }
      end = Math.min(end + 2, source.length);
      const raw = source.slice(i, end);
      comments.push({ text: raw, line: start, kind: classifyBlock(raw) });
      i = end;
      prevAllowsRegex = false;
      continue;
    }

    if (ch === "'" || ch === '"') {
      skipQuoted(ch);
      prevAllowsRegex = false;
      continue;
    }

    if (ch === '`') {
      frames.push({ kind: 'template' });
      advance();
      continue;
    }

    if (top?.kind === 'interpolation') {
      if (ch === '{') {
        top.braceDepth++;
        advance();
        prevAllowsRegex = true;
        continue;
      }
      if (ch === '}') {
        if (top.braceDepth === 0) {
          frames.pop();
          advance();
          continue;
        }
        top.braceDepth--;
        advance();
        prevAllowsRegex = false;
        continue;
      }
    }

    if (ch === '/' && prevAllowsRegex) {
      const end = scanRegexLiteral(source, i);
      if (end !== null) {
        i = end;
        prevAllowsRegex = false;
        continue;
      }
    }

    if (ch === ' ' || ch === '\t' || ch === '\r') {
      i++;
      continue;
    }

    if (ch === '\n') {
      line++;
      i++;
      continue;
    }

    if (IDENTIFIER_START.test(ch!)) {
      let end = i + 1;
      while (end < source.length && IDENTIFIER_PART.test(source[end]!)) end++;
      const word = source.slice(i, end);
      i = end;
      prevAllowsRegex = REGEX_ALLOWED_AFTER.has(word);
      continue;
    }

    if (DIGIT.test(ch!)) {
      let end = i + 1;
      while (end < source.length && NUMBER_PART.test(source[end]!)) end++;
      i = end;
      prevAllowsRegex = false;
      continue;
    }

    if (ch === ')' || ch === ']') {
      advance();
      prevAllowsRegex = false;
      continue;
    }

    advance();
    prevAllowsRegex = true;
  }

  return comments;
}
