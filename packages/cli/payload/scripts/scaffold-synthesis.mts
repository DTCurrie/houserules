#!/usr/bin/env node
/**
 * Lays out a synthesis skeleton from findings reports, one table row per finding id.
 *
 * Usage: scaffold-synthesis.mjs --destinations <a,b,...> [--template <template.md>]
 * [--jsonl <out>] <report.md>...
 *
 * The skeleton goes to stdout. It is `# Synthesis`, then the template from its first `##`
 * heading on when `--template` is given. The row table sits directly under the first
 * `## Findings` heading, or under a `## Findings` section appended at the end when the
 * template has none or no template is given. Ranking, reconciling, and merging stay with the
 * caller, so the action and destination cells repeat each finding's own proposal.
 *
 * `--destinations` lists the values a report's `destination` field may hold, the same list
 * `check-findings.mjs` takes. Every report must pass that checker's block checks.
 *
 * `--jsonl <out>` writes `<out>` instead of the skeleton, one JSON object per finding, one per
 * line, with keys `id`, `topic`, `thread`, `claim`, `source`, `quote`, `report`. `claim` is the
 * finding title. `source` and `quote` come from the first evidence line, the URL or the
 * backtick-quoted command or citation and the quoted text after `→` with its quotes or
 * backticks removed, each `null` when absent. `report` is the path as given. In this mode
 * nothing is printed to stdout and a duplicate id is not an error, so two reports that
 * disagree on one id yield two records that both carry it. Reports must still pass the block
 * checks. Topic and thread come from the report's path: a report at
 * `<domain>/research/<topic>/<thread>.md` has `topic` = `<topic>` and `thread` = `<thread>`,
 * the file stem. Any other report has `topic` = its file stem and `thread` = `null`.
 *
 * Exit 0 when written, 1 when a report fails the block checks (its result lines go to
 * stderr), when two reports share an id (both paths are named), or when a file is
 * unreadable, 2 on a usage error.
 */
import { realpathSync, writeFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { pathToFileURL } from 'node:url';

import { readCheckerInputs } from '@houserules/payload/checker-input';
import {
  checkFindings,
  formatFileResult,
  parseFindings,
} from '@houserules/payload/finding-blocks';

const USAGE =
  'usage: scaffold-synthesis.mjs --destinations <a,b,...> [--template <template.md>] [--jsonl <out>] <report.md>...';
const VALUE_OPTIONS = ['--destinations', '--template', '--jsonl'];
const EXIT_FAILED = 1;
const EXIT_USAGE_ERROR = 2;
const RESEARCH_DIRECTORY = 'research';
const FINDINGS_HEADING = '## Findings';
const TABLE_HEADER = [
  '| id | title | action | destination | source |',
  '| --- | --- | --- | --- | --- |',
];
const PLACEHOLDER_LINE =
  'No findings are merged yet. Replace this line with the merged finding blocks.';

interface ScaffoldReport {
  path: string;
  text: string;
}

interface DuplicateId {
  id: string;
  paths: string[];
}

/** Ids that appear in more than one report, or twice in one, with every path that holds them. */
export function findDuplicateIds(
  reports: readonly ScaffoldReport[],
): DuplicateId[] {
  const pathsById = new Map<string, string[]>();
  for (const report of reports)
    for (const { id } of parseFindings(report.text))
      pathsById.set(id, [...(pathsById.get(id) ?? []), report.path]);
  return [...pathsById]
    .filter(([, paths]) => paths.length > 1)
    .map(([id, paths]) => ({ id, paths }));
}

interface FindingRecord {
  id: string;
  topic: string;
  thread: string | null;
  claim: string;
  source: string | null;
  quote: string | null;
  report: string;
}

function stripQuoting(value: string): string {
  const match = /^(["`])(.*)\1$/.exec(value);
  return match ? (match[2] as string) : value;
}

function firstEvidence(line: string | undefined): {
  source: string | null;
  quote: string | null;
} {
  if (line === undefined) return { source: null, quote: null };
  const arrowIndex = line.indexOf('→');
  const head = (arrowIndex === -1 ? line : line.slice(0, arrowIndex)).trim();
  const tail = arrowIndex === -1 ? '' : line.slice(arrowIndex + 1).trim();
  const source = stripQuoting(head) || null;
  return { source, quote: tail ? stripQuoting(tail) : null };
}

/** `topic` and `thread` for a report path, by the `<domain>/research/<topic>/<thread>.md` layout. */
function topicAndThread(path: string): {
  topic: string;
  thread: string | null;
} {
  const [researchSegment, topicSegment, fileSegment] = path
    .replace(/\\/g, '/')
    .split('/')
    .slice(-3);
  const stem = basename(path, extname(path));
  const isInResearchTree =
    researchSegment === RESEARCH_DIRECTORY && fileSegment !== undefined;
  return isInResearchTree
    ? { topic: topicSegment as string, thread: stem }
    : { topic: stem, thread: null };
}

/** One record per finding, in report order then file order. Duplicate ids are kept. */
function findingRecords(reports: readonly ScaffoldReport[]): FindingRecord[] {
  return reports.flatMap(({ path, text }) => {
    const { topic, thread } = topicAndThread(path);
    return parseFindings(text).map(({ id, title, fields }) => ({
      id,
      topic,
      thread,
      claim: title,
      ...firstEvidence(fields.get('evidence')?.[0]),
      report: path,
    }));
  });
}

function tableCell(value: string | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim().replace(/\|/g, '\\|');
}

function tableLines(reports: readonly ScaffoldReport[]): string[] {
  const rows = reports.flatMap(({ path, text }) =>
    parseFindings(text).map(
      ({ id, title, fields }) =>
        `| ${id} | ${tableCell(title)} | ${tableCell(fields.get('candidate action')?.[0])} | ${tableCell(fields.get('destination')?.[0])} | \`${path}#${id}\` |`,
    ),
  );
  return [...TABLE_HEADER, ...rows, '', PLACEHOLDER_LINE];
}

function templateBody(templateText: string): string[] {
  const lines = templateText.replace(/\r\n/g, '\n').split('\n');
  const firstSectionIndex = lines.findIndex((line) => /^## /.test(line));
  return firstSectionIndex === -1 ? [] : lines.slice(firstSectionIndex);
}

/**
 * Builds the skeleton for reports that already passed the block checks. The caller owns
 * duplicate detection, since a duplicate id is a failure and not a layout.
 */
export function scaffoldSynthesis(
  reports: readonly ScaffoldReport[],
  templateText: string | undefined,
): string {
  const table = tableLines(reports);
  const body = templateText === undefined ? [] : templateBody(templateText);
  const findingsHeadingIndex = body.findIndex(
    (line) => line.trim() === FINDINGS_HEADING,
  );
  const lines =
    findingsHeadingIndex === -1
      ? [
          '# Synthesis',
          '',
          ...body,
          ...(body.length > 0 && body[body.length - 1] !== '' ? [''] : []),
          FINDINGS_HEADING,
          '',
          ...table,
          '',
        ]
      : [
          '# Synthesis',
          '',
          ...body.slice(0, findingsHeadingIndex + 1),
          '',
          ...table,
          ...body.slice(findingsHeadingIndex + 1),
        ];
  return lines.join('\n');
}

interface Invocation {
  files: string[];
  destinations: string;
  template: string | undefined;
  jsonl: string | undefined;
}

function usageError(message: string): never {
  console.error(message);
  console.error(USAGE);
  process.exit(EXIT_USAGE_ERROR);
}

function parseArguments(args: readonly string[]): Invocation {
  const files: string[] = [];
  const options: Record<string, string> = {};
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] as string;
    if (VALUE_OPTIONS.includes(arg)) {
      const value = args[++index];
      if (!value || value.startsWith('--')) usageError(`${arg} needs a value`);
      options[arg.slice(2)] = value;
    } else if (arg.startsWith('--')) usageError(`unknown option ${arg}`);
    else files.push(arg);
  }
  if (!options.destinations) usageError('--destinations is required');
  if (files.length === 0) usageError('no file given');
  return {
    files,
    destinations: options.destinations,
    template: options.template,
    jsonl: options.jsonl,
  };
}

/** Prints each report's block defects to stderr, and says whether there were any. */
function reportBlockDefects(
  reports: readonly ScaffoldReport[],
  destinations: ReadonlySet<string>,
): boolean {
  let hasFailure = false;
  for (const { path, text } of reports) {
    const defects = checkFindings(text, destinations);
    if (defects.length === 0) continue;
    hasFailure = true;
    console.error(formatFileResult(path, parseFindings(text).length, defects));
  }
  return hasFailure;
}

/** Prints each id held by more than one report to stderr, and says whether there were any. */
function reportDuplicateIds(reports: readonly ScaffoldReport[]): boolean {
  const duplicates = findDuplicateIds(reports);
  for (const { id, paths: holders } of duplicates)
    console.error(`duplicate id ${id} in ${holders.join(' and ')}`);
  return duplicates.length > 0;
}

function main(): void {
  const invocation = parseArguments(process.argv.slice(2));
  const destinations = new Set(
    invocation.destinations.split(',').filter(Boolean),
  );
  const paths = [
    ...invocation.files,
    ...(invocation.template ? [invocation.template] : []),
  ];
  const { inputs, unreadable } = readCheckerInputs(paths);
  if (unreadable.length > 0) {
    for (const finding of unreadable)
      console.error(`${finding.file}: ${finding.msg}`);
    process.exit(EXIT_FAILED);
  }
  const textByPath = new Map(inputs.map((input) => [input.path, input.text]));
  const reports = invocation.files.map((path) => ({
    path,
    text: textByPath.get(path) as string,
  }));

  const hasBlockDefects = reportBlockDefects(reports, destinations);
  const hasDuplicateIds = !invocation.jsonl && reportDuplicateIds(reports);
  if (hasBlockDefects || hasDuplicateIds) process.exit(EXIT_FAILED);

  if (invocation.jsonl) {
    const lines = findingRecords(reports).map((record) =>
      JSON.stringify(record),
    );
    writeFileSync(invocation.jsonl, lines.map((line) => `${line}\n`).join(''));
    return;
  }

  const templateText = invocation.template
    ? (textByPath.get(invocation.template) as string)
    : undefined;
  process.stdout.write(scaffoldSynthesis(reports, templateText));
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(realpathSync(entry)).href)
  main();
