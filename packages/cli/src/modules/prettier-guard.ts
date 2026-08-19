import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type { Action, RegionSpec } from '@houserules/api';
import type { Ctx } from '../detect.js';

/**
 * houserules' managed block in `.prettierignore`. Exported because `doctor` has to ask
 * whether it is present before blaming the formatter for an install full of local edits,
 * and a marker string defined in two places is how a managed region silently stops being
 * found.
 */
export const PRETTIERIGNORE_REGION: RegionSpec = {
  id: 'prettierignore',
  start: '# houserules:prettierignore start',
  end: '# houserules:prettierignore end',
  anchor: 'eof',
};

// Kind-of-tracked-by-whole-file-hash actions. `seed` (user-owned, written once) and
// `region` (only the marker span is hashed, not the file) are deliberately excluded, which
// is also why `.claude/settings.json` never appears: it is a `merge-settings` action, not
// tracked by whole-file hash at all, so formatting it costs nothing.
const HASH_TRACKED_KINDS = new Set(['copy', 'write', 'body']);

const KIT_MANIFEST = '.claude/houserules.manifest.json';

// A seed, not tracked by whole-file hash, so `protectedSubtrees` never derives it. It still
// belongs in the block: houserules rewrites this file in its own fixed style whenever `init` or
// `modules` changes the module set, so the formatting is kit-owned even though the values
// inside it are the user's. A repo whose prettier config disagrees with that style would
// otherwise get churn on every run, undone by the next write.
const KIT_CONFIG = '.claude/houserules.config.json';

/**
 * The `.claude/` subtrees the given plan actually writes and tracks by content hash, plus
 * the fixed set of paths houserules formats its own way for reasons other than a content hash
 * (`KIT_MANIFEST`, `KIT_CONFIG`). Formatting any of them rewrites bytes houserules owns, and
 * `update` then reads the whole install as your local edits and refuses to refresh it.
 *
 * The first path segment under `.claude/`, not the full containing directory, because
 * `.claude/agents/` and `.claude/skills/` hold the user's own files beside houserules' and
 * no glob separates them: ignoring the umbrella directory is the intent, not an
 * imprecision. A dest directly under `.claude/` (`.claude/houserules.manifest.json`) contributes
 * that file path itself, since there is no subtree to name.
 *
 * Derived from `actions` rather than hardcoded, so a module that starts writing a new
 * `.claude/` subtree (an output style, say) is covered the day its action lands, instead
 * of drifting out of sync with a list nobody remembers to update.
 */
function protectedSubtrees(actions: Action[]): string[] {
  const entries = new Set<string>([KIT_MANIFEST, KIT_CONFIG]);

  for (const action of actions) {
    if (!HASH_TRACKED_KINDS.has(action.kind)) continue;
    const dest = (action as { dest: string }).dest;
    if (!dest.startsWith('.claude/')) continue;
    const rest = dest.slice('.claude/'.length);
    const slash = rest.indexOf('/');
    entries.add(slash === -1 ? dest : `.claude/${rest.slice(0, slash)}/`);
  }

  return [...entries].sort();
}

function prettierignoreBody(subtrees: string[]): string {
  return [
    '# Installed by houserules and tracked by content hash. Formatting these rewrites',
    '# bytes houserules owns, which makes `npx houserules update` skip them as your edits.',
    ...subtrees,
  ].join('\n');
}

function eslintIgnoresAdvice(subtrees: string[]): string {
  const globs = subtrees.map((entry) =>
    entry.endsWith('/') ? `"**/${entry}**"` : `"${entry}"`,
  );
  return `eslint flat config is JavaScript, so houserules cannot edit it for you. Add this to your config's \`ignores\`: [${globs.join(', ')}].`;
}

// Flat config is a JavaScript module, not data, so houserules cannot safely splice an
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
 * Keeps the host repo's formatter off the files houserules tracks by hash.
 *
 * `actions` must be the full plan, every enabled module's actions, not just this module's
 * own. The block protects whatever the plan actually writes under `.claude/`, so a
 * caller that has not yet collected every module's actions would derive an incomplete
 * block.
 *
 * Part of `core` rather than of `lint-fix`, even though `lint-fix`'s Stop hook is the most
 * common way the formatter gets dragged across `.claude/`. The fragility belongs to the
 * install, not to that hook. A repo with prettier and no fix script still needs the block,
 * and `lint-fix` does not even enable itself there.
 */
export function prettierGuardActions(ctx: Ctx, actions: Action[]): Action[] {
  const result: Action[] = [];
  const subtrees = protectedSubtrees(actions);

  // A repo with no prettier must not gain a .prettierignore it never had.
  if (ctx.prettier) {
    result.push({
      kind: 'region',
      dest: '.prettierignore',
      body: prettierignoreBody(subtrees),
      region: PRETTIERIGNORE_REGION,
      module: 'core',
      reason:
        'protects kit-owned files from a repo-wide `prettier --write` (content outside the markers is never touched)',
    });
  }

  if (hasEslintFlatConfig(ctx.root)) {
    result.push({
      kind: 'advise',
      text: eslintIgnoresAdvice(subtrees),
      module: 'core',
    });
  }

  return result;
}
