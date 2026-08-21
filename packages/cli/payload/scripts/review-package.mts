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
import { dirname, join } from 'node:path';

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

function resolveSha(root: string, ref: string): string {
  const sha = git(root, ['rev-parse', '--verify', '--quiet', ref]);
  if (!sha) fail(`unknown ref "${ref}"`);
  return sha.trim();
}

function runPackage(rangeArg: string, outArg: string | undefined): void {
  const sep = rangeArg.indexOf('..');
  const base = sep >= 0 ? rangeArg.slice(0, sep) : '';
  const head = sep >= 0 ? rangeArg.slice(sep + 2) : '';
  if (!base || !head)
    fail(`range must look like <base>..<head>, got "${rangeArg}"`);

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
  const filesChangedMatch = stat.match(/(\d+) files? changed/);
  const filesChanged = filesChangedMatch ? Number(filesChangedMatch[1]) : 0;

  const generated = new Date().toISOString().slice(0, 10);
  const content = `${[
    `# Review package: ${base}..${head}`,
    '',
    `Base \`${base}\` resolved to \`${baseSha}\`. Head \`${head}\` resolved to \`${headSha}\`. Generated ${generated}.`,
    '',
    '## Commits',
    '',
    fenced(log),
    '',
    '## Stat',
    '',
    fenced(stat),
    '',
    '## Diff',
    '',
    fenced(diff),
  ].join('\n')}\n`;

  const out =
    outArg ??
    join(
      root,
      '.claude/plans',
      `review-package-${base.replace(/\//g, '-')}-${head.replace(/\//g, '-')}.md`,
    );
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, content);

  process.stdout.write(
    `${out}\n${commits.length} commit(s), ${filesChanged} file(s) changed\n`,
  );
}

/** The `## Slices` section's lines, from just after the heading to the next `## ` heading or EOF. */
function slicesSection(lines: string[], phaseFile: string): string[] {
  const headingIndex = lines.findIndex((l) => l.trim() === '## Slices');
  if (headingIndex < 0) fail(`"${phaseFile}" has no "## Slices" section`);
  let end = lines.length;
  for (let i = headingIndex + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i] as string)) {
      end = i;
      break;
    }
  }
  return lines.slice(headingIndex + 1, end);
}

function runBriefs(phaseFile: string, sliceId: string | undefined): void {
  if (!existsSync(phaseFile)) fail(`no such file "${phaseFile}"`);
  const lines = readFileSync(phaseFile, 'utf8').split('\n');
  const tableLines = slicesSection(lines, phaseFile).filter((l) =>
    l.trim().startsWith('|'),
  );
  if (tableLines.length < 2)
    fail(`"${phaseFile}" has no slice table under "## Slices"`);
  const header = tableLines[0] as string;
  const divider = tableLines[1] as string;
  const rows = tableLines.slice(2);

  if (!sliceId) {
    process.stdout.write(`${[header, divider, ...rows].join('\n')}\n`);
    return;
  }

  const row = rows.find((r) => r.split('|')[1]?.trim() === sliceId);
  if (!row) fail(`slice "${sliceId}" not found in "${phaseFile}"`);
  process.stdout.write(`${[header, divider, row].join('\n')}\n`);
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

try {
  main();
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
}
