// Unified diffs for the doctor report (claude-kit CLI).
//
// Human-facing only: a diff is never compared, hashed, or applied. `-` lines are
// what is on disk, `+` lines are what the kit would write — so reading a hunk
// answers "what would --fix change" without running it.

import { structuredPatch } from 'diff';

export function unifiedDiff(from: string, to: string, context = 3): string {
  const { hunks } = structuredPatch('', '', from, to, '', '', { context });
  return hunks
    .flatMap((hunk) => [
      `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
      ...hunk.lines,
    ])
    .join('\n');
}

/** Cap a diff so one badly-drifted file cannot flood the report. */
export function truncateDiff(diff: string, maxLines = 40): string {
  const lines = diff.split('\n');
  if (lines.length <= maxLines) return diff;
  return [
    ...lines.slice(0, maxLines),
    `… ${lines.length - maxLines} more diff line(s)`,
  ].join('\n');
}
