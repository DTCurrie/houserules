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
 * Splits a file into the frontmatter you own and the body the kit owns. This is the cut
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

/**
 * What the user has done with a body-owned file's frontmatter.
 *
 * - `default`      untouched, so the kit refreshes it along with the body, silently
 * - `customized`   yours, and the kit's default has not moved, so there is nothing to say
 * - `default-moved` yours, AND the kit shipped a different default since. The one case
 *   worth a message, because it is the only one where you might want to look
 */
export type FrontmatterState = 'default' | 'customized' | 'default-moved';

/**
 * Decides which of the three states a body-owned file's frontmatter is in. Pure, and the
 * single definition both the write path in `computeEffects` and the report path in
 * `computeDrift` read, so what the kit writes and what it says can never disagree.
 *
 * Three hashes are needed, not two. Comparing disk against the shipped default only says
 * they differ, not whether YOU moved or the KIT did. The recorded default is what
 * separates them, exactly as the manifest separates `stale` from `yours` for whole files.
 *
 * @param recordedDefault What the kit last shipped here, from the manifest. Undefined for
 *   an entry written before body ownership existed, where the kit has no record of its own
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
