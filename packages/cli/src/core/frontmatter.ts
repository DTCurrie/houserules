// A frontmatter block only counts at the very start of the file, which is where every
// tool that reads one looks. The lazy inner match stops at the FIRST closing `---`, so a
// `---` divider later in the body is not mistaken for the end of the block.
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/** A file cut at the end of its frontmatter. The two halves concatenate back to the input. */
export interface FrontmatterSplit {
  /**
   * The `---` block, both delimiters and the newline after the closing one included.
   * Empty when the file has no frontmatter.
   */
  frontmatter: string;
  /** Everything after the closing `---`. The whole file when there is no frontmatter. */
  body: string;
}

/**
 * Splits a file into the frontmatter you own and the body houserules owns. This is the cut
 * `BodyAction` is defined in terms of, so the two halves must concatenate back to the
 * original byte for byte. A file with no frontmatter is all body, which is what makes a
 * rule stripped of its `paths:` still refreshable.
 */
export function splitFrontmatter(text: string): FrontmatterSplit {
  const found = FRONTMATTER.exec(text);
  if (!found) return { frontmatter: '', body: text };
  return {
    frontmatter: found[0],
    body: text.slice(found[0].length),
  };
}

/** The text BETWEEN the `---` delimiters, or null when the file has no frontmatter. */
export function frontmatterBlock(text: string): string | null {
  const found = FRONTMATTER.exec(text);
  if (!found) return null;
  const captured = found[1];
  return captured === undefined ? null : captured;
}

/** A `paths:` key in the shape shipped rules write it, one single-quoted glob per line. */
function pathsLines(paths: readonly string[], lineEnd: string): string[] {
  if (paths.length === 0) return [`paths: []${lineEnd}`];
  return [
    `paths:${lineEnd}`,
    ...paths.map((glob) => `  - '${glob.replaceAll("'", "''")}'${lineEnd}`),
  ];
}

/**
 * A line that continues the value of the key above it: an indented line, or a block
 * sequence item written flush with its key.
 */
function continuesValue(line: string): boolean {
  return /^[ \t]/.test(line) || /^-(?:[ \t]|\r?$)/.test(line);
}

/**
 * Renders a config-owned `paths:` value into a rule's frontmatter. The `paths:` key and its
 * value are replaced, or appended when the frontmatter has none, and every other byte is
 * kept, delimiters and line endings included. A file with no frontmatter gains a block that
 * holds only `paths:`.
 *
 * @param frontmatter The frontmatter half {@link splitFrontmatter} returns, possibly empty.
 */
export function renderFrontmatterPaths(
  frontmatter: string,
  paths: readonly string[],
): string {
  const found = FRONTMATTER.exec(frontmatter);
  if (!found) return `---\n${pathsLines(paths, '').join('\n')}\n---\n`;
  const inner = found[1] ?? '';
  const opening = frontmatter.startsWith('---\r\n') ? '---\r\n' : '---\n';
  const closing = frontmatter.slice(opening.length + inner.length);
  const lineEnd = opening === '---\r\n' ? '\r' : '';
  // Split on `\n` alone so a `\r` stays on its line and an untouched line keeps its bytes.
  // The last line's own `\r` sits in `closing`, so it borrows one while lines move around.
  const lines = inner === '' ? [] : inner.split('\n');
  if (lines.length > 0) lines[lines.length - 1] += lineEnd;
  const start = lines.findIndex((line) => /^paths[ \t]*:/.test(line));
  let rendered: string[];
  if (start === -1) {
    rendered = [...lines, ...pathsLines(paths, lineEnd)];
  } else {
    let end = start + 1;
    while (end < lines.length && continuesValue(lines[end] ?? '')) end++;
    rendered = [
      ...lines.slice(0, start),
      ...pathsLines(paths, lineEnd),
      ...lines.slice(end),
    ];
  }
  const last = rendered.length - 1;
  if (lineEnd !== '' && last >= 0) {
    rendered[last] = (rendered[last] ?? '').replace(/\r$/, '');
  }
  return opening + rendered.join('\n') + closing;
}

/** One block sequence item's scalar, or null for a shape this reader does not take. */
function sequenceItem(raw: string): string | null {
  const single = /^'((?:[^']|'')*)'$/.exec(raw);
  if (single) return (single[1] ?? '').replaceAll("''", "'");
  const double = /^"((?:[^"\\]|\\["\\])*)"$/.exec(raw);
  if (double) return (double[1] ?? '').replace(/\\(["\\])/g, '$1');
  if (raw === '' || /^['"[\]{}&*!|>%@`#,?:-]/.test(raw)) return null;
  if (/[ \t]#|:[ \t]|:$/.test(raw)) return null;
  return raw;
}

/**
 * Reads the `paths:` key from a rule's frontmatter: `paths: []`, or a block sequence whose
 * items are single-quoted (with `''` escapes), double-quoted, or bare.
 *
 * @param frontmatter The frontmatter half {@link splitFrontmatter} returns.
 * @returns Null when there is no frontmatter, no `paths:` key, or a shape it cannot read.
 */
export function parseFrontmatterPaths(frontmatter: string): string[] | null {
  const inner = frontmatterBlock(frontmatter);
  if (inner === null) return null;
  const lines = inner.split('\n').map((line) => line.replace(/\r$/, ''));
  const start = lines.findIndex((line) => /^paths[ \t]*:/.test(line));
  if (start === -1) return null;
  const value = (lines[start] ?? '').replace(/^paths[ \t]*:/, '').trim();
  if (value === '[]') return [];
  if (value !== '') return null;
  const paths: string[] = [];
  for (let index = start + 1; index < lines.length; index++) {
    const line = lines[index] ?? '';
    if (!continuesValue(line)) break;
    const item = /^[ \t]*-[ \t]+(.*?)[ \t]*$/.exec(line);
    if (!item) return null;
    const glob = sequenceItem(item[1] ?? '');
    if (glob === null) return null;
    paths.push(glob);
  }
  return paths.length === 0 ? null : paths;
}

/**
 * What the user has done with a body-owned file's frontmatter.
 *
 * - `default`      untouched, so houserules refreshes it along with the body, silently
 * - `customized`   yours, and houserules' default has not moved, so there is nothing to say
 * - `default-moved` yours, AND houserules shipped a different default since. The one case
 *   worth a message, because it is the only one where you might want to look
 */
export type FrontmatterState = 'default' | 'customized' | 'default-moved';

/**
 * Decides which of the three states a body-owned file's frontmatter is in. Pure, and the
 * single definition both the write path in `computeEffects` and the report path in
 * `computeDrift` read, so what houserules writes and what it says can never disagree.
 *
 * Three hashes are needed, not two. Comparing disk against the shipped default only says
 * they differ, not whether YOU moved or houserules did. The recorded default is what
 * separates them, exactly as the manifest separates `stale` from `yours` for whole files.
 *
 * @param recordedDefault What houserules last shipped here, from the manifest. Undefined for
 *   an entry written before body ownership existed, where houserules has no record of its own
 *   default. That resolves to `customized`, the choice that never overwrites.
 */
export function classifyFrontmatter(args: {
  onDisk: string;
  recordedDefault: string | undefined;
  shippedDefault: string;
}): FrontmatterState {
  const { onDisk, recordedDefault, shippedDefault } = args;
  if (recordedDefault === undefined) return 'customized';
  if (onDisk === recordedDefault) return 'default';
  return recordedDefault === shippedDefault ? 'customized' : 'default-moved';
}
