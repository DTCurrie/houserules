import { existsSync, readFileSync } from 'node:fs';

import type { TokenCandidate, TokenGroup } from './dtcg-normalize.mjs';
import {
  parseColor,
  parseDimension,
  parseFontFamily,
  parseFontWeight,
} from './dtcg-normalize.mjs';

const SOURCE = 'css custom property';
const COMMENT_PATTERN = /\/\*[\s\S]*?\*\//g;
const RULE_BLOCK_PATTERN = /([^{}]*)\{([^{}]*)\}/g;
const DECLARATION_PATTERN = /--([a-zA-Z0-9-_]+)\s*:\s*([^;]+);?/g;
const VAR_REFERENCE_PATTERN = /^var\(/i;
const ROOT_SELECTORS = new Set([':root', 'html']);

function stripComments(css: string): string {
  return css.replace(COMMENT_PATTERN, '');
}

function isRootSelector(selectorList: string): boolean {
  return selectorList
    .split(',')
    .map((selector) => selector.trim().toLowerCase())
    .some((selector) => ROOT_SELECTORS.has(selector));
}

function extractRootBlockBodies(css: string): string[] {
  const bodies: string[] = [];
  for (const match of css.matchAll(RULE_BLOCK_PATTERN)) {
    const [, selectorList, body] = match;
    if (isRootSelector(selectorList)) bodies.push(body);
  }
  return bodies;
}

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[-_]/g, '');
}

function looksLikeFontFamily(raw: string): boolean {
  return raw.includes(',') || /^['"]/.test(raw);
}

/**
 * Classifies a declaration's value into a {@link TokenGroup} by shape first, then by what the
 * property name suggests, per the extraction rules a design token reader follows.
 */
function classifyDeclaration(
  name: string,
  raw: string,
): TokenGroup | undefined {
  if (parseColor(raw) !== undefined) return 'color';

  const normalizedName = normalizeName(name);
  if (normalizedName.includes('weight') && parseFontWeight(raw) !== undefined)
    return 'fontWeight';

  if (looksLikeFontFamily(raw) && parseFontFamily(raw) !== undefined)
    return 'fontFamily';

  if (parseDimension(raw) !== undefined) {
    if (normalizedName.includes('radius') || normalizedName.includes('round'))
      return 'radius';
    if (normalizedName.includes('fontsize') || normalizedName.includes('text'))
      return 'fontSize';
    return 'spacing';
  }

  return undefined;
}

/**
 * The name prefixes each group answers to, longest first so `font-weight-` is tested before
 * `font-`. Stripping these is what lets a `:root` property and a Tailwind `@theme` property
 * describing the same token produce the same key, which is what the caller's source-priority
 * merge compares on. Without it `--color-brand` yields `color.color-brand` from one reader and
 * `color.brand` from the other, and the higher-priority value never wins because the two never
 * collide.
 */
const GROUP_NAME_PREFIXES: Record<TokenGroup, string[]> = {
  color: ['color-'],
  spacing: ['spacing-', 'space-'],
  radius: ['radius-', 'rounded-'],
  fontSize: ['font-size-', 'text-'],
  fontWeight: ['font-weight-', 'weight-'],
  fontFamily: ['font-family-', 'font-'],
};

/** Drops a leading prefix that only restates the group the token already sits in. */
function stripGroupPrefix(group: TokenGroup, name: string): string {
  for (const prefix of GROUP_NAME_PREFIXES[group]) {
    if (name.length > prefix.length && name.startsWith(prefix)) {
      return name.slice(prefix.length);
    }
  }
  return name;
}

function extractDeclarations(body: string): TokenCandidate[] {
  const candidates: TokenCandidate[] = [];
  for (const match of body.matchAll(DECLARATION_PATTERN)) {
    const [, name, rawValue] = match;
    const raw = rawValue.trim();
    if (VAR_REFERENCE_PATTERN.test(raw)) continue;

    const group = classifyDeclaration(name, raw);
    if (group === undefined) continue;

    candidates.push({
      group,
      name: stripGroupPrefix(group, name),
      raw,
      occurrences: 1,
      source: SOURCE,
    });
  }
  return candidates;
}

/**
 * Finds `--name: value` declarations inside `:root` or `html` selector blocks and classifies
 * each into a {@link TokenGroup}. Never throws, returning an empty array for CSS with nothing
 * to extract.
 */
export function extractCssCustomProperties(css: string): TokenCandidate[] {
  try {
    const withoutComments = stripComments(css);
    const bodies = extractRootBlockBodies(withoutComments);
    return bodies.flatMap((body) => extractDeclarations(body));
  } catch {
    return [];
  }
}

/**
 * Reads each stylesheet that exists on disk and merges the {@link TokenCandidate}s found in it.
 * A missing file contributes nothing, silently, since the caller already discovered this list.
 * A file that exists but could not be read also contributes nothing, but is named in
 * `unreadableFiles` so a caller can tell that apart from a file that read cleanly and simply had
 * no root-level custom properties.
 */
export function readCssCustomProperties(filePaths: string[]): {
  candidates: TokenCandidate[];
  unreadableFiles: string[];
} {
  const candidates: TokenCandidate[] = [];
  const unreadableFiles: string[] = [];
  for (const filePath of filePaths) {
    if (!existsSync(filePath)) continue;
    try {
      const css = readFileSync(filePath, 'utf8');
      candidates.push(...extractCssCustomProperties(css));
    } catch {
      unreadableFiles.push(filePath);
    }
  }
  return { candidates, unreadableFiles };
}
