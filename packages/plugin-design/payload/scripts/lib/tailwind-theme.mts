import { readFileSync, existsSync } from 'node:fs';

import type { TokenCandidate, TokenGroup } from './dtcg-normalize.mjs';

const THEME_BLOCK_START = /@theme(?:\s+(?:default|static|inline))*\s*\{/g;
const COMMENT_PATTERN = /\/\*[\s\S]*?\*\//g;
const DECLARATION_PATTERN = /--([a-zA-Z0-9-]+)\s*:\s*([^;]+);/g;
const TAILWIND_SOURCE = 'tailwind @theme';
const TAILWIND_V3_CONFIG_NAMES = new Set([
  'tailwind.config.js',
  'tailwind.config.ts',
  'tailwind.config.cjs',
  'tailwind.config.mjs',
]);

const PREFIX_GROUPS: { prefix: string; group: TokenGroup }[] = [
  { prefix: 'color-', group: 'color' },
  { prefix: 'spacing-', group: 'spacing' },
  { prefix: 'radius-', group: 'radius' },
  { prefix: 'font-weight-', group: 'fontWeight' },
  { prefix: 'font-', group: 'fontFamily' },
  { prefix: 'text-', group: 'fontSize' },
];

function stripComments(cssText: string): string {
  return cssText.replace(COMMENT_PATTERN, '');
}

/** Returns the byte ranges `{ start, end }` of every `@theme { ... }` block, `end` exclusive of the closing brace. */
function findThemeBlockBodies(cssText: string): string[] {
  const bodies: string[] = [];
  THEME_BLOCK_START.lastIndex = 0;
  // Only `lastIndex` is read, so the match itself is never bound.
  while (THEME_BLOCK_START.exec(cssText) !== null) {
    const bodyStart = THEME_BLOCK_START.lastIndex;
    const bodyEnd = findMatchingBraceEnd(cssText, bodyStart);
    if (bodyEnd === undefined) continue;
    bodies.push(cssText.slice(bodyStart, bodyEnd));
    THEME_BLOCK_START.lastIndex = bodyEnd;
  }
  return bodies;
}

/** Walks forward from just after an opening brace and returns the index of its matching closing brace. */
function findMatchingBraceEnd(
  cssText: string,
  bodyStart: number,
): number | undefined {
  let depth = 1;
  for (let index = bodyStart; index < cssText.length; index += 1) {
    if (cssText[index] === '{') depth += 1;
    else if (cssText[index] === '}') depth -= 1;
    if (depth === 0) return index;
  }
  return undefined;
}

function mapPropertyToGroup(
  property: string,
): { group: TokenGroup; name: string } | undefined {
  for (const { prefix, group } of PREFIX_GROUPS) {
    if (property.startsWith(prefix)) {
      return { group, name: property.slice(prefix.length) };
    }
  }
  return undefined;
}

function extractDeclarations(blockBody: string): TokenCandidate[] {
  const candidates: TokenCandidate[] = [];
  DECLARATION_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = DECLARATION_PATTERN.exec(blockBody)) !== null) {
    const mapped = mapPropertyToGroup(match[1]);
    if (!mapped) continue;
    candidates.push({
      group: mapped.group,
      name: mapped.name,
      raw: match[2].trim(),
      occurrences: 1,
      source: TAILWIND_SOURCE,
    });
  }
  return candidates;
}

/**
 * Finds every Tailwind v4 `@theme` block in `cssText` and returns the custom properties inside
 * as {@link TokenCandidate}s. Returns an empty array when the text has no `@theme` block or is
 * malformed, never throws.
 */
export function extractTailwindThemeCandidates(
  cssText: string,
): TokenCandidate[] {
  const withoutComments = stripComments(cssText);
  const candidates: TokenCandidate[] = [];
  for (const blockBody of findThemeBlockBodies(withoutComments)) {
    candidates.push(...extractDeclarations(blockBody));
  }
  return candidates;
}

/**
 * Reads each existing file in `filePaths` as CSS and returns the merged
 * {@link extractTailwindThemeCandidates} results. Missing files are skipped.
 */
export function readTailwindThemeCandidates(
  filePaths: string[],
): TokenCandidate[] {
  const candidates: TokenCandidate[] = [];
  for (const filePath of filePaths) {
    if (!existsSync(filePath)) continue;
    const cssText = readFileSync(filePath, 'utf8');
    candidates.push(...extractTailwindThemeCandidates(cssText));
  }
  return candidates;
}

/**
 * Reports whether `filePaths` includes a Tailwind v3 JS config file. The caller uses this to
 * warn that only v4's CSS `@theme` is supported, without reading or executing the config.
 */
export function hasTailwindV3Config(filePaths: string[]): boolean {
  return filePaths.some((filePath) => {
    const segments = filePath.split('/');
    const fileName = segments[segments.length - 1];
    return TAILWIND_V3_CONFIG_NAMES.has(fileName);
  });
}
