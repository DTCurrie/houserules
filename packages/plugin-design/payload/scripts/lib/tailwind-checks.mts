import { checkDesign } from './design-checks.mjs';
import type { CheckResult } from './design-checks.mjs';
import { scanCandidates } from './tailwind-candidates.mjs';
import type { ScannedCandidate } from './tailwind-candidates.mjs';
import type { LoadedDesignSystem } from './tailwind-design-system.mjs';
import type { TailwindResult } from './tailwind-host-packages.mjs';

const DECLARATION_TEXT_PATTERN = /[a-zA-Z-]+\s*:\s*[^;{}]+;/g;

/**
 * What the coverage summary counts on this path. The declarations handed to `checkDesign` are
 * compiled from class candidates, so calling them declarations would read as the file's own
 * `<style>` block, which is the other coverage line printed beside this one.
 */
const TAILWIND_COVERAGE_UNIT = 'Tailwind class candidates';

/**
 * Groups candidates by their source line.
 *
 * Oxide is not attribute-aware, so it never says which candidates share one `class`
 * attribute. Grouping by line is the honest approximation: a class list that wraps across
 * lines splits into two groups, which loses a pairing rather than inventing one that was
 * never there.
 */
function groupByLine(
  candidates: ScannedCandidate[],
): Map<number, ScannedCandidate[]> {
  const groups = new Map<number, ScannedCandidate[]>();
  for (const candidate of candidates) {
    const existing = groups.get(candidate.line);
    if (existing) existing.push(candidate);
    else groups.set(candidate.line, [candidate]);
  }
  return groups;
}

/**
 * Pulls every `property: value;` pair out of a compiled rule, ignoring its selector and any
 * wrapping at-rule such as a responsive variant's `@media` block. `checkDesign` only reads
 * declarations, so the selector Tailwind generated is discarded rather than reused.
 */
function extractDeclarationTexts(css: string): string[] {
  return css.match(DECLARATION_TEXT_PATTERN) ?? [];
}

/**
 * Checks a file's Tailwind class candidates against the design system's checks.
 *
 * A candidate compiles to real CSS through `candidatesToCss`, whose `null` return is the
 * filter: it is the only thing that tells a real utility such as `bg-brand-500` apart from a
 * non-utility string such as `isOpen` that Oxide also collected. The surviving declarations
 * are rewritten under one synthetic selector per source line and handed to `checkDesign`,
 * which already knows how to judge them, so no check is duplicated here.
 *
 * A `bg-*` utility declared on an ancestor element is invisible to this source-side scan.
 * Resolving a composited background is `render`'s job, not this one's.
 *
 * @returns Findings whose `line` is the real line in `filePath`, never a line in the
 * synthetic CSS built to check it. `{ ok: false, error }` when the file could not be scanned,
 * including a missing `@tailwindcss/oxide`.
 */
export async function checkTailwindClasses(
  root: string,
  filePath: string,
  designSystem: LoadedDesignSystem,
  tokens: Record<string, unknown>,
): Promise<TailwindResult<CheckResult>> {
  const scanned = await scanCandidates(root, filePath);
  if (!scanned.ok) return scanned;

  const groups = groupByLine(scanned.value);
  const realLines = [...groups.keys()].sort((left, right) => left - right);

  const syntheticLines: string[] = [];
  const realLineOfSyntheticLine: number[] = [];

  for (const realLine of realLines) {
    const candidates = groups.get(realLine) ?? [];
    const compiled = designSystem.candidatesToCss(
      candidates.map((candidate) => candidate.candidate),
    );
    const declarationTexts = compiled
      .filter((css): css is string => css !== null)
      .flatMap(extractDeclarationTexts);
    if (declarationTexts.length === 0) continue;

    syntheticLines.push(
      `.c${syntheticLines.length + 1} { ${declarationTexts.join(' ')} }`,
    );
    realLineOfSyntheticLine.push(realLine);
  }

  const result = checkDesign(
    syntheticLines.join('\n'),
    tokens,
    TAILWIND_COVERAGE_UNIT,
  );

  return {
    ok: true,
    value: {
      ...result,
      findings: result.findings.map((finding) => ({
        ...finding,
        line: realLineOfSyntheticLine[finding.line - 1] ?? finding.line,
      })),
    },
  };
}
