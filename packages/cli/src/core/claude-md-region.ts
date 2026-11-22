import type { InstructionsFile, RegionSpec } from '@houserules/api';

/**
 * The one `RegionSpec` for the kit-owned block inside CLAUDE.md. Both the seed
 * (`renderClaudeMd`) and the region action (`core.ts`'s plan) build off this so the markers
 * can never drift between the two: a seeded file's block and a spliced update's block are
 * always the same shape.
 */
export const claudeMdRegion: RegionSpec = {
  id: 'claude-md',
  start: '<!-- houserules:claude-md start -->',
  end: '<!-- houserules:claude-md end -->',
  anchor: 'after-h1',
  pad: true,
  legacy: {
    start: '<!-- claude-kit:claude-md start -->',
    end: '<!-- claude-kit:claude-md end -->',
  },
};

/**
 * The ignored, manifest-tracked file that holds the rendered houserules sections when the
 * instructions file is CLAUDE.md. The region imports it, so a release that changes the
 * sections rewrites only this file and never the user's tracked CLAUDE.md.
 */
export const CLAUDE_MD_IMPORT_TARGET = '.claude/houserules.md';

/** The region body CLAUDE.md carries: one `@` import line, the same bytes for every section set. */
export const CLAUDE_MD_IMPORT_BODY = `@${CLAUDE_MD_IMPORT_TARGET}\n`;

/**
 * Whether the region in `instructionsFile` is the import line rather than the full sections.
 * Only Claude Code resolves `@` imports, and other tools read AGENTS.md without them, so
 * AGENTS.md keeps the full region.
 */
export function regionImportsSections(
  instructionsFile: InstructionsFile,
): boolean {
  return instructionsFile === 'CLAUDE.md';
}
