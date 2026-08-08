import type { Ctx } from '../detect.js';

export const DEFAULT_LEDGER_DIR = '.claude/ledgers';

/**
 * The repo-relative ledger directory, or null when the kit must not manage it.
 *
 * Mirrors `ledgerDir` in the payload's entry-ledger lib, which the scripts use at runtime.
 * Null for a path that is absolute, escapes the repo, or resolves to the repo root. The root
 * matters most: the kit self-ignores this directory with `*`, and that rule at the repo root
 * would hide every file in the project.
 *
 * Its own module because three callers need the same answer. Core writes the ignore file,
 * doctor reports committed ledgers, and update untracks them. Resolving it separately in each
 * is how the two ledger scripts drifted apart before this was written down.
 */
export function ledgerDirFor(ctx: Ctx): string | null {
  const configured = ctx.claude.kitConfig?.ledgers?.dir;
  if (!configured) return DEFAULT_LEDGER_DIR;
  const normalized = configured.replace(/\/+$/, '');
  if (!normalized || normalized === '.' || normalized.startsWith('/')) {
    return null;
  }
  return normalized.split('/').includes('..') ? null : normalized;
}
