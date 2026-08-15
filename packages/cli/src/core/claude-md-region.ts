import type { RegionSpec } from '@houserules/api';

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
