#!/usr/bin/env node
/**
 * Flags a source filename `code-cleanliness.md`'s catch-all rule names outright:
 * `types.ts`, `constants.ts`, `utils.ts`, `shared.ts`, `helpers.ts`. Matched on the
 * basename alone, any extension, so `utils.tsx` and `helpers.mts` both match too.
 *
 * A basename check, not a content check. Whether a genuinely single-responsibility file
 * happens to be named `shared.ts` is still the rule's call, and this checker only ever
 * flags the name.
 *
 * Usage: catch-all-filename.mjs <file> [<file> ...]
 */
import { basename, extname } from 'node:path';
import { existsSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import {
  emptyReport,
  exitCodeFor,
  renderReport,
  type Report,
} from '@houserules/payload/findings';

const BLOCKED_STEMS = new Set([
  'types',
  'constants',
  'utils',
  'shared',
  'helpers',
]);

const DECLINED = [
  "whether a file with an allowed name is itself a catch-all in disguise, which needs reading its contents and is the rule's own judgment call",
];

/** Findings for one path. Takes the path alone, since only the basename is examined. */
export function checkFilename(file: string): Report {
  const report = emptyReport();
  const name = basename(file);
  const stem = name.slice(0, name.length - extname(name).length).toLowerCase();
  if (BLOCKED_STEMS.has(stem)) {
    report.findings.push({
      rule: 'code-cleanliness/no-catch-all-files',
      level: 'error',
      file,
      line: null,
      msg: `"${name}" is a catch-all filename. Never create types.ts, constants.ts, utils.ts, shared.ts, or helpers.ts — name the file for its job.`,
    });
  }
  return report;
}

function main(): void {
  const files = process.argv.slice(2);
  const report = emptyReport();
  report.declined.push(...DECLINED);
  for (const file of files) {
    if (!existsSync(file)) continue;
    report.findings.push(...checkFilename(file).findings);
  }
  process.stdout.write(`${renderReport(report)}\n`);
  process.exit(exitCodeFor(report));
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
  main();
}
