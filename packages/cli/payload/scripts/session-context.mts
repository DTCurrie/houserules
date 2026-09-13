#!/usr/bin/env node
/**
 * SessionStart hook. Prints an orientation header of at most four lines: branch,
 * uncommitted files, and affected houserules targets, so the agent does not re-derive it with
 * full `git status` reads.
 *
 * stdout becomes session context, so this stays tiny. Every failure path exits 0.
 */

import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import {
  loadConfigSafe,
  repoRootSafe,
  type ConfigTarget,
} from '@houserules/payload/config';
import { git } from '@houserules/payload/proc';

// Past this many changed files, a per-target summary is more useful than a file list.
const MAX_INLINE_FILES = 25;
// How many of the changed files to name inline before collapsing to "…".
const MAX_LISTED_FILES = 10;

/** Counts changed files per configured target, so the summary can name where work landed. */
function countByTarget(
  changed: string[],
  targets: ConfigTarget[],
): Map<string, number> {
  const byTarget = new Map<string, number>();
  for (const path of changed) {
    const target = targets.find((candidate) =>
      candidate.pathPrefix ? path.startsWith(candidate.pathPrefix) : true,
    );
    if (target) byTarget.set(target.name, (byTarget.get(target.name) ?? 0) + 1);
  }
  return byTarget;
}

/**
 * The uncommitted-work lines, or none when the tree is clean.
 *
 * Extracted from the caller so each branch reads at one level of nesting. Past a threshold
 * the file list is replaced by a per-target tally, since a session-start banner listing
 * eighty paths is noise rather than context.
 */
export function uncommittedLines(
  changed: string[],
  targets: ConfigTarget[],
): string[] {
  if (!changed.length) return [];
  const byTarget = countByTarget(changed, targets);

  if (changed.length > MAX_INLINE_FILES) {
    const summary = [...byTarget.entries()]
      .map(([name, count]) => `${name} (${count})`)
      .join(', ');
    return [
      `[houserules] uncommitted: ${changed.length} files${summary ? ` — ${summary}` : ''}`,
    ];
  }

  const shown = changed.slice(0, MAX_LISTED_FILES).join(', ');
  const lines = [
    `[houserules] uncommitted (${changed.length}): ${shown}${changed.length > MAX_LISTED_FILES ? ', …' : ''}`,
  ];
  if (byTarget.size) {
    lines.push(
      `[houserules] targets touched: ${[...byTarget.keys()].join(', ')}`,
    );
  }
  return lines;
}

/** The `[houserules] branch: ...` line, with an ahead/behind suffix when `counts` names one. */
export function formatBranchLine(
  branch: string | undefined,
  counts: string | undefined,
): string {
  let tracking = '';
  if (counts) {
    const [behind, ahead] = counts.split(/\s+/).map(Number);
    const bits = [
      ahead ? `ahead ${ahead}` : null,
      behind ? `behind ${behind}` : null,
    ].filter(Boolean);
    if (bits.length) tracking = ` (${bits.join(', ')})`;
  }
  return `[houserules] branch: ${branch ?? '(no commits yet)'}${tracking}`;
}

function main(): void {
  try {
    const root = repoRootSafe();
    if (root) {
      const lines = [];
      const branch = git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])?.trim();
      const counts = git(root, [
        'rev-list',
        '--left-right',
        '--count',
        '@{upstream}...HEAD',
      ])?.trim();
      lines.push(formatBranchLine(branch, counts));

      const status = git(root, ['status', '--porcelain']) ?? '';
      const changed = status
        .split('\n')
        .filter(Boolean)
        .map((l) => l.slice(3).trim());
      const targets = loadConfigSafe(root).targets ?? [];
      lines.push(...uncommittedLines(changed, targets));
      console.log(lines.join('\n'));
    }
  } catch {
    // Never block session start.
  }
  process.exit(0);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
  main();
}
