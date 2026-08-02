import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { extractBody } from '../core/regions.js';
import { PRETTIERIGNORE_REGION } from './prettier-guard.js';

/**
 * More than a couple of kit-owned files under `.claude/` reading as local edits, with no
 * `.prettierignore` block to explain it, is unlikely to be deliberate. A formatter run
 * over the whole repo is the far more likely cause.
 */
const SUSPECTED_FORMATTER_MANGLE_THRESHOLD = 2;

function prettierignoreBlockPresent(root: string): boolean {
  let content: string;
  try {
    content = readFileSync(join(root, '.prettierignore'), 'utf8');
  } catch {
    return false;
  }
  return extractBody(content, PRETTIERIGNORE_REGION) !== null;
}

/**
 * Names the likely cause when an install reads as edited wholesale, so the user is not
 * left with `--force` as the only lever and no reason to trust it.
 *
 * Shared by `doctor` and `update` because they reach the same conclusion from the same
 * evidence, and a repo that hits this usually runs the one that does not warn.
 *
 * @param editedPaths Repo-relative dests whose bytes no longer match what the kit wrote.
 * @param remedy The command that restores them, worded for the calling command.
 * @returns The hint, or null when the count is too low to blame a formatter or a
 *   `.prettierignore` block already rules one out.
 */
export function formatterMangleHint(
  root: string,
  editedPaths: string[],
  remedy: string,
): string | null {
  const underClaude = editedPaths.filter((path) => path.startsWith('.claude/'));
  if (underClaude.length <= SUSPECTED_FORMATTER_MANGLE_THRESHOLD) return null;
  if (prettierignoreBlockPresent(root)) return null;
  return (
    `${underClaude.length} kit-owned file(s) under .claude/ show local edits ` +
    'and no .prettierignore block protects them. A repo-wide formatter run is the ' +
    `likely cause. ${remedy}`
  );
}
