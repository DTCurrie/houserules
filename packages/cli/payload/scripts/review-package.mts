#!/usr/bin/env node
/**
 * Packages a commit range into one markdown file a reviewer agent reads in a single call:
 * the commits, the diffstat, and the full diff. A second mode extracts a slice's row, or the
 * whole table, from a plan phase file's `## Slices` section, for a slice-scoped review brief.
 *
 * Usage:
 *   review-package.mjs <base>..<head> [--out <path>]
 *   review-package.mjs --briefs <phase-file> [<slice-id>]
 *
 * Exit codes: 0 on success. 1 on a bad range, an unknown ref, an empty range, a non-git
 * directory, or a missing/malformed briefs file — always with a one-line stderr message,
 * never a stack trace.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { git, repoRoot } from '@houserules/payload/proc';

function fail(message: string): never {
  process.stderr.write(`review-package: ${message}\n`);
  process.exit(1);
}

/** A fence longer than any backtick run already inside `text`, so it can never collide. */
function fenceFor(text: string): string {
  let longest = 0;
  for (const m of text.matchAll(/`+/g))
    longest = Math.max(longest, m[0].length);
  return '`'.repeat(Math.max(longest + 1, 3));
}

function fenced(text: string): string {
  const fence = fenceFor(text);
  return [fence, text, fence].join('\n');
}

/** Splits `<base>..<head>` into its two refs, or `null` when either side is empty. */
export function parseRange(
  rangeArg: string,
): { base: string; head: string } | null {
  const sep = rangeArg.indexOf('..');
  const base = sep >= 0 ? rangeArg.slice(0, sep) : '';
  const head = sep >= 0 ? rangeArg.slice(sep + 2) : '';
  if (!base || !head) return null;
  return { base, head };
}

/** Where a package prints when `--out` is not given: under `.claude/plans/`, ref names slashed. */
export function defaultOutPath(
  root: string,
  base: string,
  head: string,
): string {
  return join(
    root,
    '.claude/plans',
    `review-package-${base.replace(/\//g, '-')}-${head.replace(/\//g, '-')}.md`,
  );
}

/** The `files changed` count out of a `git diff --stat` summary line, or 0 when absent. */
export function parseFilesChanged(stat: string): number {
  const match = stat.match(/(\d+) files? changed/);
  return match ? Number(match[1]) : 0;
}

/** The markdown body a review package writes, from its already-resolved pieces. */
export function buildReviewContent(input: {
  base: string;
  head: string;
  baseSha: string;
  headSha: string;
  log: string;
  stat: string;
  diff: string;
  generated: string;
}): string {
  return `${[
    `# Review package: ${input.base}..${input.head}`,
    '',
    `Base \`${input.base}\` resolved to \`${input.baseSha}\`. Head \`${input.head}\` resolved to \`${input.headSha}\`. Generated ${input.generated}.`,
    '',
    '## Commits',
    '',
    fenced(input.log),
    '',
    '## Stat',
    '',
    fenced(input.stat),
    '',
    '## Diff',
    '',
    fenced(input.diff),
  ].join('\n')}\n`;
}

/** The outcome of pulling a `## Slices` table out of a phase file's lines. */
export type SliceTableResult =
  | { kind: 'no-section' }
  | { kind: 'no-table' }
  | { kind: 'ok'; header: string; divider: string; rows: string[] };

/**
 * The `## Slices` table: everything from just after that heading to the next `## ` heading
 * or EOF, filtered to table rows. `no-section` when the heading is absent, `no-table` when
 * fewer than a header and a divider row remain.
 */
export function extractSliceTable(lines: string[]): SliceTableResult {
  const headingIndex = lines.findIndex((l) => l.trim() === '## Slices');
  if (headingIndex < 0) return { kind: 'no-section' };
  let end = lines.length;
  for (let i = headingIndex + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i] as string)) {
      end = i;
      break;
    }
  }
  const tableLines = lines
    .slice(headingIndex + 1, end)
    .filter((l) => l.trim().startsWith('|'));
  if (tableLines.length < 2) return { kind: 'no-table' };
  return {
    kind: 'ok',
    header: tableLines[0] as string,
    divider: tableLines[1] as string,
    rows: tableLines.slice(2),
  };
}

/** The row whose `id` column (the table's first cell) matches `sliceId`, if any. */
export function findSliceRow(
  rows: string[],
  sliceId: string,
): string | undefined {
  return rows.find((r) => r.split('|')[1]?.trim() === sliceId);
}

function resolveSha(root: string, ref: string): string {
  const sha = git(root, ['rev-parse', '--verify', '--quiet', ref]);
  if (!sha) fail(`unknown ref "${ref}"`);
  return sha.trim();
}

function runPackage(rangeArg: string, outArg: string | undefined): void {
  const range = parseRange(rangeArg);
  if (!range) fail(`range must look like <base>..<head>, got "${rangeArg}"`);
  const { base, head } = range;

  let root: string;
  try {
    root = repoRoot();
  } catch {
    root = process.cwd();
  }
  if (!git(root, ['rev-parse', '--git-dir']))
    fail(`"${root}" is not a git repository`);

  const baseSha = resolveSha(root, base);
  const headSha = resolveSha(root, head);

  const log = (
    git(root, ['log', '--oneline', `${baseSha}..${headSha}`]) ?? ''
  ).trimEnd();
  const commits = log.split('\n').filter(Boolean);
  if (!commits.length) fail(`no commits between "${base}" and "${head}"`);

  const stat = (
    git(root, ['diff', '--stat', `${baseSha}..${headSha}`]) ?? ''
  ).trimEnd();
  const diff = (
    git(root, ['diff', '-U10', `${baseSha}..${headSha}`]) ?? ''
  ).trimEnd();
  const filesChanged = parseFilesChanged(stat);

  const generated = new Date().toISOString().slice(0, 10);
  const content = buildReviewContent({
    base,
    head,
    baseSha,
    headSha,
    log,
    stat,
    diff,
    generated,
  });

  const out = outArg ?? defaultOutPath(root, base, head);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, content);

  process.stdout.write(
    `${out}\n${commits.length} commit(s), ${filesChanged} file(s) changed\n`,
  );
}

function runBriefs(phaseFile: string, sliceId: string | undefined): void {
  if (!existsSync(phaseFile)) fail(`no such file "${phaseFile}"`);
  const lines = readFileSync(phaseFile, 'utf8').split('\n');
  const table = extractSliceTable(lines);
  if (table.kind === 'no-section')
    fail(`"${phaseFile}" has no "## Slices" section`);
  if (table.kind === 'no-table')
    fail(`"${phaseFile}" has no slice table under "## Slices"`);

  if (!sliceId) {
    process.stdout.write(
      `${[table.header, table.divider, ...table.rows].join('\n')}\n`,
    );
    return;
  }

  const row = findSliceRow(table.rows, sliceId);
  if (!row) fail(`slice "${sliceId}" not found in "${phaseFile}"`);
  process.stdout.write(`${[table.header, table.divider, row].join('\n')}\n`);
}

function main(): void {
  const argv = process.argv.slice(2);

  if (argv[0] === '--briefs') {
    const phaseFile = argv[1];
    if (!phaseFile) fail('--briefs requires a phase file path');
    runBriefs(phaseFile, argv[2]);
    return;
  }

  const rangeArg = argv[0];
  if (!rangeArg)
    fail('usage: review-package.mjs <base>..<head> [--out <path>]');
  const outIndex = argv.indexOf('--out');
  const outArg = outIndex >= 0 ? argv[outIndex + 1] : undefined;
  if (outIndex >= 0 && !outArg) fail('--out requires a path');
  runPackage(rangeArg, outArg);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
  try {
    main();
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}
