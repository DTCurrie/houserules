/**
 * Lowest-priority token source: scans UI files for raw style literals with no theme or custom
 * property backing them, and ranks each distinct value by how often it appears. Frequency is
 * the whole signal here, since an inferred value has no author intent to fall back on.
 */

import { readFileSync } from 'node:fs';

import type { TokenCandidate, TokenGroup } from './dtcg-normalize.mjs';

/** One distinct literal value found in a single scan pass, with its occurrence count. */
interface RawLiteralCount {
  group: TokenGroup;
  raw: string;
  count: number;
}

const MAX_CANDIDATES_PER_GROUP = 16;
const MIN_OCCURRENCES_TO_EMIT = 2;

const COMMENT_PATTERN = /\/\*[\s\S]*?\*\//g;
const DECLARATION_PATTERN = /([a-zA-Z-]+)\s*:\s*([^;{}"']+)/g;
const HEX_COLOR_PATTERN =
  /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g;
const FUNCTIONAL_COLOR_PATTERN = /(?:rgba?|oklch)\([^)]*\)/gi;
const DIMENSION_PATTERN = /-?[0-9]*\.?[0-9]+(?:px|rem)\b/g;

const SPACING_PROPERTIES = new Set([
  'gap',
  'row-gap',
  'column-gap',
  'inset',
  'top',
  'right',
  'bottom',
  'left',
]);

/** Normalizes a value for counting. Hex colors fold case so `#FFF` and `#fff` count as one. */
function normalizeLiteralKey(raw: string): string {
  const trimmed = raw.trim();
  return trimmed.startsWith('#') ? trimmed.toLowerCase() : trimmed;
}

/** The group a dimension on this CSS property belongs to, or undefined if the property is unmapped. */
function mapPropertyToDimensionGroup(property: string): TokenGroup | undefined {
  const name = property.trim().toLowerCase();
  if (name === 'font-size') return 'fontSize';
  if (
    name === 'border-radius' ||
    (name.startsWith('border-') && name.endsWith('-radius'))
  ) {
    return 'radius';
  }
  if (
    SPACING_PROPERTIES.has(name) ||
    name.startsWith('margin') ||
    name.startsWith('padding')
  ) {
    return 'spacing';
  }
  return undefined;
}

function recordOccurrence(
  counts: Map<TokenGroup, Map<string, RawLiteralCount>>,
  group: TokenGroup,
  raw: string,
): void {
  const key = normalizeLiteralKey(raw);
  const byValue = counts.get(group) ?? new Map<string, RawLiteralCount>();
  const existing = byValue.get(key);
  if (existing) {
    existing.count += 1;
  } else {
    byValue.set(key, { group, raw: raw.trim(), count: 1 });
  }
  counts.set(group, byValue);
}

function recordColors(
  counts: Map<TokenGroup, Map<string, RawLiteralCount>>,
  value: string,
): void {
  for (const match of value.matchAll(HEX_COLOR_PATTERN)) {
    recordOccurrence(counts, 'color', match[0]);
  }
  for (const match of value.matchAll(FUNCTIONAL_COLOR_PATTERN)) {
    recordOccurrence(counts, 'color', match[0]);
  }
}

function recordDimensions(
  counts: Map<TokenGroup, Map<string, RawLiteralCount>>,
  property: string,
  value: string,
): void {
  const group = mapPropertyToDimensionGroup(property);
  if (!group) return;
  for (const match of value.matchAll(DIMENSION_PATTERN)) {
    recordOccurrence(counts, group, match[0]);
  }
}

/**
 * Scans CSS declarations and inline `style=` attributes in `text` for color and dimension
 * literals, counting how often each distinct value occurs within this text.
 */
export function countStyleLiteralsInText(text: string): RawLiteralCount[] {
  const withoutComments = text.replace(COMMENT_PATTERN, '');
  const counts = new Map<TokenGroup, Map<string, RawLiteralCount>>();

  for (const match of withoutComments.matchAll(DECLARATION_PATTERN)) {
    const [, property, value] = match;
    recordColors(counts, value);
    recordDimensions(counts, property, value);
  }

  return [...counts.values()].flatMap((byValue) => [...byValue.values()]);
}

function mergeLiteralCounts(
  target: Map<TokenGroup, Map<string, RawLiteralCount>>,
  fromFile: RawLiteralCount[],
): void {
  for (const entry of fromFile) {
    const byValue =
      target.get(entry.group) ?? new Map<string, RawLiteralCount>();
    const key = normalizeLiteralKey(entry.raw);
    const existing = byValue.get(key);
    if (existing) {
      existing.count += entry.count;
    } else {
      byValue.set(key, { ...entry });
    }
    target.set(entry.group, byValue);
  }
}

/**
 * Names a candidate by its group and rank within that group, such as `color-1` or
 * `spacing-2`, since an inferred literal has no author-given name.
 */
function nameForRank(group: TokenGroup, rank: number): string {
  return `${group}-${rank}`;
}

/**
 * Ranks a group's distinct values by frequency, then narrows to what a first draft should
 * actually propose: values seen only once are almost never real tokens, so the
 * {@link MIN_OCCURRENCES_TO_EMIT} floor drops them before the {@link MAX_CANDIDATES_PER_GROUP}
 * cap trims the remainder.
 */
function rankAndCapGroup(
  group: TokenGroup,
  entries: RawLiteralCount[],
): { candidates: TokenCandidate[]; droppedCount: number } {
  const ranked = [...entries].sort((left, right) => right.count - left.count);
  const aboveFloor = ranked.filter(
    (entry) => entry.count >= MIN_OCCURRENCES_TO_EMIT,
  );
  const kept = aboveFloor.slice(0, MAX_CANDIDATES_PER_GROUP);
  const candidates = kept.map((entry, index) => ({
    group,
    name: nameForRank(group, index + 1),
    raw: entry.raw,
    occurrences: entry.count,
    source: 'literal scan',
  }));
  return { candidates, droppedCount: ranked.length - kept.length };
}

/**
 * Reads each file in `filePaths`, scans it for style literals, merges occurrence counts across
 * files, and returns the result as `TokenCandidate[]` ranked by frequency within each group.
 * A file that cannot be read is skipped rather than failing the whole scan.
 *
 * @returns The ranked candidates, and how many distinct values were dropped by the occurrence
 * floor or the per-group cap.
 */
export function collectStyleTokenCandidates(filePaths: string[]): {
  candidates: TokenCandidate[];
  droppedCount: number;
} {
  const counts = new Map<TokenGroup, Map<string, RawLiteralCount>>();

  for (const filePath of filePaths) {
    let text: string;
    try {
      text = readFileSync(filePath, 'utf8');
    } catch {
      continue;
    }
    mergeLiteralCounts(counts, countStyleLiteralsInText(text));
  }

  const candidates: TokenCandidate[] = [];
  let droppedCount = 0;
  for (const [group, byValue] of counts) {
    const ranked = rankAndCapGroup(group, [...byValue.values()]);
    candidates.push(...ranked.candidates);
    droppedCount += ranked.droppedCount;
  }

  return { candidates, droppedCount };
}
