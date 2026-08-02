import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type { Action } from '../actions.js';
import type { RegionSpec } from '../core/regions.js';
import type { Ctx } from '../detect.js';

/**
 * The kit's managed block in `.prettierignore`. Exported because `doctor` has to ask
 * whether it is present before blaming the formatter for an install full of local edits,
 * and a marker string defined in two places is how a managed region silently stops being
 * found.
 */
export const PRETTIERIGNORE_REGION: RegionSpec = {
  id: 'prettierignore',
  start: '# claude-kit:prettierignore start',
  end: '# claude-kit:prettierignore end',
  anchor: 'eof',
};

/**
 * The subtrees the kit tracks by content hash. Formatting any of them rewrites bytes the
 * kit owns, and `update` then reads the whole install as your local edits and refuses to
 * refresh it. That is silent, which is why the kit writes this rather than documenting it.
 *
 * Directory-level and not file-level, because `.claude/agents/` and `.claude/skills/` hold
 * your own files beside the kit's and no glob separates them. `.claude/settings.json` is
 * deliberately absent: it is merged key by key against a signature, not tracked by whole-file
 * hash, so formatting it costs nothing.
 */
export const PRETTIERIGNORE_BODY = [
  '# Installed by claude-kit and tracked by content hash. Formatting these rewrites',
  '# bytes the kit owns, which makes `npx claude-kit update` skip them as your edits.',
  '.claude/agents/',
  '.claude/kit-manifest.json',
  '.claude/kit-templates/',
  '.claude/reference/',
  '.claude/rules/',
  '.claude/scripts/',
  '.claude/skills/',
].join('\n');

// Flat config is a JavaScript module, not data, so the kit cannot safely splice an
// `ignores` entry into it. An `advise` line is the only option, and none of these
// filenames are distinguished, so any one existing means we hand the user the entry.
const ESLINT_FLAT_CONFIG_FILES = [
  'eslint.config.js',
  'eslint.config.mjs',
  'eslint.config.cjs',
  'eslint.config.ts',
];

function hasEslintFlatConfig(root: string): boolean {
  return ESLINT_FLAT_CONFIG_FILES.some((name) => existsSync(join(root, name)));
}

/**
 * Keeps the host repo's formatter off the files the kit tracks by hash.
 *
 * Part of `core` rather than of `lint-fix`, even though `lint-fix`'s Stop hook is the most
 * common way the formatter gets dragged across `.claude/`. The fragility belongs to the
 * install, not to that hook. A repo with prettier and no fix script still needs the block,
 * and `lint-fix` does not even enable itself there.
 */
export function prettierGuardActions(ctx: Ctx): Action[] {
  const actions: Action[] = [];

  // A repo with no prettier must not gain a .prettierignore it never had.
  if (ctx.prettier) {
    actions.push({
      kind: 'region',
      dest: '.prettierignore',
      body: PRETTIERIGNORE_BODY,
      region: PRETTIERIGNORE_REGION,
      module: 'core',
      reason:
        'protects kit-owned files from a repo-wide `prettier --write` (content outside the markers is never touched)',
    });
  }

  if (hasEslintFlatConfig(ctx.root)) {
    actions.push({
      kind: 'advise',
      text: 'eslint flat config is JavaScript, so the kit cannot edit it for you. Add this to your config\'s `ignores`: ["**/.claude/agents/**", ".claude/kit-manifest.json", "**/.claude/kit-templates/**", "**/.claude/reference/**", "**/.claude/rules/**", "**/.claude/scripts/**", "**/.claude/skills/**"].',
      module: 'core',
    });
  }

  return actions;
}
